const bodyParser = require('body-parser');
const buildConfig = require('./build-config.js');
const express = require('express');
const log = require('./logger');
const octokat = require('octokat');
const rx = require('rx');
const state = require('./state');
const pullRequest = require('./pull-request');
const repoBranch = require('./repo-branch');

rx.config.longStackSupport = true;

let app = express();
app.use(bodyParser.json());

let github = new octokat({
	token: process.env.GITHUB_TOKEN,
	rootURL: 'https://git/api/v3'
})

let gitHubSubjects = {
	'issue_comment': new rx.Subject(),
	'push': new rx.Subject(),
	'pull_request': new rx.Subject(),
	'ping': new rx.Subject()
};

let jenkinsSubject =new rx.Subject(); 

function gitHubWebHookHandler(req, res) {
	const gitHubEvent = req.headers['x-github-event'];
	const subject = gitHubSubjects[gitHubEvent];
	if (subject) {
		subject.onNext(req.body);
		res.status(204).send();
	} else {
		res.status(400).send();
	}
};

function jenkinsWebHookHandler(req, res) {
	this.jenkinsSubject.onNext(req.body);
	res.status(204).send();
};

app.get('/', (req, res) => res.send('leeroy-pull-request-builder'));
app.post('/event_handler', gitHubWebHookHandler);
app.post('/jenkins', jenkinsWebHookHandler);

const buildRepoUrl = /^git@git:([^/]+)\/([^.]+).git$/;
const includePr = /Include https:\/\/git\/(.*?)\/(.*?)\/pull\/(\d+)/i;

function getLeeroyConfigs() {
	return github.repos('Build', 'Configuration').contents.fetch()
		.then(function (contents) {
			log.debug(`Build/Configuration has ${contents.length} files.`);
			var jsonFiles = contents.filter(function (elem) {
				return elem.path.indexOf('.json') === elem.path.length - 5;
			});
			return Promise.all(jsonFiles.map(function (elem) {
				return github.repos('Build', 'Configuration').contents(elem.path).read()
					.then(function (contents) {
						try {
							return JSON.parse(contents);
						}
						catch (e) {
							// log.debug('Invalid JSON in ' + elem.path);
							return null;
						}
					});
			}));
		})
		.then(function (files) {
			var configs = files.filter(function (f) {
				return f && !f.disabled && f.submodules && f.pullRequestBuildUrls && buildRepoUrl.test(f.repoUrl);
			});
			log.info(`Found ${configs.length} enabled files with submodules and PR build URLs.`);
			return configs;
		});
}

function mapGitHubPullRequest(ghpr) {
	return pullRequest.create(repoBranch.create(ghpr.base.repo.owner.login, ghpr.base.repo.name, ghpr.base.ref),
		repoBranch.create(ghpr.head.repo.owner.login, ghpr.head.repo.name, ghpr.head.ref),
		ghpr.number,
		`PR #${ghpr.number}: ${ghpr.title}`);
}

function getGitHubPullRequestId(ghpr) {
	return mapGitHubPullRequest(ghpr).id;
}

function mapLeeroyConfig(leeroyConfig) {
	let [, user, repo] = buildRepoUrl.exec(leeroyConfig.repoUrl) || [];
	return buildConfig.create(
		repoBranch.create(user, repo, leeroyConfig.branch || 'master'),
		leeroyConfig.pullRequestBuildUrls.map(function (buildUrl) {
			var match = /\/job\/([^/]+)\/buildWithParameters/.exec(buildUrl);
			return {
				name: match && match[1],
				url: buildUrl
			};
		})
			.filter(job => job.name ? true : false),
		leeroyConfig.submodules
	);
}

// observable of all pushes to Build/Configuration
const configurationPushes = gitHubSubjects['push']
	.filter(push => push.repository.full_name === 'Build/Configuration' && push.ref === 'refs/heads/master')
	.startWith(null)
	.flatMap(getLeeroyConfigs)
	.share();

// update Leeroy configs every time Build/Configuration is pushed
configurationPushes
	.flatMap(rx.Observable.from)
	.map(mapLeeroyConfig)
	.subscribe(state.addBuildConfig);

// get all existing open PRs when Build/Configuration is pushed
const existingPrs = configurationPushes
	.flatMap(() => state.getReposToWatch())
	.flatMap(repo => github.repos(repo).pulls.fetch())
	.flatMap(pulls => pulls);
const newPrs = gitHubSubjects['pull_request']
	.filter(pr => pr.action === 'opened');
const allPrs = existingPrs.merge(newPrs);

allPrs
	.map(mapGitHubPullRequest)
	.subscribe(state.addPullRequest);

const allPrBodies = allPrs.map(x => ({ id: getGitHubPullRequestId(x), body: x.body }));
const existingIssueComments = existingPrs
	.flatMap(x => {
		const id = getGitHubPullRequestId(x);
		return rx.Observable.fromPromise(github.repos(x.base.repo.owner.login, x.base.repo.name).issues(x.number).comments.fetch())
			.flatMap(x => { id, x.body });
	});
const newIssueComments = gitHubSubjects['issue_comment']
	.map(ic => ({ id: `${ic.repository.full_name}/${ic.issue.number}`, body: ic.comment.body }));
	
const allComments = allPrBodies.merge(existingIssueComments).merge(newIssueComments)
	.map(x => ({ id: x.id, match: includePr.exec(x.body) }))
	.filter(x => x.match)
	.map(x => ({ parent: x.id, child: `${x.match[1]}/${x.match[2]}/${x.match[3]}` }))
	.subscribe(x => state.addPullRequestDependency(x.parent, x.child), e => log.error(e));

let started = false;
function startServer(port) {
	if (started)
		throw new Error('Server is already started.');
	started = true;
	log.info(`Starting server on port ${port}`);
	app.listen(port);	
}

exports.start = startServer;
