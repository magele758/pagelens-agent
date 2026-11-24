# Agent notes

Start from the [product feature map](docs/feature-map.md) to locate the user-visible control, implementation and relevant tests. Update its row when an entry point or contract moves.

- Use a separate Git worktree and a pull request for each change. Start from the current `origin/main` unless the PR depends on another open branch. In that case, target the predecessor branch and retarget to `main` after that branch merges. Run the local checks and wait for the PR checks before merging. Once the change is verified end to end, merge the PR right away and update the local checkout to the latest `main` — do not leave tested PRs or stale branches open.
- TikTok MX product drafts use PTC by default for new listings and reruns. Put product-dependent decisions (category, attributes, variant interpretation, bilingual copy, and package estimates) in the listing PTC programs. Run independent field agents in parallel and pass structured results between agents when one field depends on another. Reuse the shared form tools for source SKU binding, price calculations, browser writes, and refresh verification. Extend the shared form tools when the seller introduces a new control.
