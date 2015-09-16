'use strict';

function create(base, head, number, title, mergeCommitSha) {
	return Object.create({}, {
		base: { value: base },
		head: { value: head },
		number: { value: number },
		title: { value: title },
		mergeCommitSha: { value: mergeCommitSha },
		id: { get() { return `${this.base.user}/${this.base.repo}/${this.number}`; } }
	});
}

exports.create = create;
