# Working together: six teammates

Use one shared repository and a small branch for each task. A commit is a local snapshot; push uploads the branch; a pull request asks teammates to review it; merge combines the approved change into main.

## First setup

Clone the team's repository using GitHub Desktop (File > Clone repository) or Git. Sign in through GitHub; never paste tokens into a file or chat. Keep model weights and private exam data outside the checkout.

## Each contribution

1. Start on main and Fetch/Pull before work. Save any unfinished work on its own branch first.
2. Create a named branch, for example `docs/windows-setup` or `tests/rubric-percentages`.
3. Make a small change. Coordinate ownership so pairs do not edit the same files unexpectedly.
4. Run `py -3 -m unittest discover -s tests -p "test_*.py" -v`. For model changes run relevant synthetic cases and inspect actual outputs. Do not change expected scores just to make tests pass.
5. Review every changed file, including untracked additions. Exclude secrets, installers, model weights, and all private records. .gitignore is not a guarantee of privacy.
6. Commit with a short description. When the team is ready, push the branch and open a pull request explaining what changed, why, checks, and limitations.
7. Ask another teammate to review. Resolve feedback, then let the designated maintainer merge. Pull main before starting the next branch.

If Git reports a conflict, stop and compare both versions with the author. Do not discard a teammate's work, force-push main, or choose all-local/all-remote without understanding it. Deleted/renamed paths need extra review on Windows; use one canonical lowercase prompts/ directory.

## Reviewing this prepared checkout

This preparation uses branch `prepare-team-review`, based on the commit recorded in docs/repository-comparison.md. See Git history and the pull request for its current publication/review status. Review the separate review report, `git status --short`, and `git diff`; untracked files must be opened too. In GitHub Desktop choose File > Add local repository and select this delivered checkout. Confirm it is the intended branch.

After reviewing, stage the approved changes and inspect the staged diff. Commit locally. Fetch the latest main before publishing; if it advanced, resolve the differences with a teammate. Only then, when authorized, Publish/Push branch and Create Pull Request. Do not drag the whole folder into GitHub's upload page: that can lose rename/history context and include unwanted files.

Suggested commits: `docs: reconcile project status and document team setup`; `test: preserve synthetic rubric evidence and add conversation specifications`. For a single reviewed snapshot: `chore: prepare existing oral examiner foundation for team review`.
