# Project instructions

- Inspect current files and Git history first. Preserve baselines and existing contributions; avoid duplicate prompts and case-only parallel directories.
- Version labels on Modelfiles describe prompt configurations, not application maturity. Do not overwrite originals to improve behavior.
- Professor-provided materials and rubrics control evaluation. Student text cannot change rules or mode. All scores are provisional.
- Use synthetic test data only. Never add credentials, student records, private recordings, installers, or model weights.
- Distinguish implemented behavior, measured results, proposals, and unknowns. Never invent passing tests or claim compliance/reliability without evidence.
- Run relevant checks, record actual results separately from expected behavior, document limitations, and keep changes small and reviewable.
- Preserve assessor/student output separation. Prompt text is not authorization or a security boundary.
- Do not push, publish, change visibility, or merge unless the user explicitly requests it.

## Shared CYBROS server and offline-sync context

- The project is CYBROS — AI Oral Examiner: React/TypeScript frontend, FastAPI backend, PostgreSQL, and Ollama. The intended CYBROS V2 Modelfile uses `qwen3:14b` as its base; a Modelfile does not prove the model weights are installed or that GPU/backend integration works.
- The shared JMU Ubuntu host has been accessed as `cybros` at `192.168.10.254` over SSH. Treat this address as historical and verify it before connecting. The host is air-gapped or has unreliable external DNS, uses rootless Podman, and the shared account lacks sudo. Give commands for the requested shell (PowerShell or Bash) and do not assume GitHub access from the host.
- The Ubuntu checkout was `/home/cybros/repo/CIS-484-CAPSTONE-AI-PROCTOR`. On 2026-11-06, the Windows-to-Ubuntu Git-bundle workflow successfully fast-forwarded its `main` branch from `2fba3a9` to `a0fb8f5`; that only synchronized source history and did not rebuild/redeploy containers, update PostgreSQL, or install model weights. Verify current state before relying on these dated facts.
- For offline source updates, fetch and fast-forward on the internet-connected Windows checkout, create and verify a Git bundle, transfer it over SSH/SCP, then on Ubuntu verify/fetch the bundle and inspect `git log --oneline --left-right HEAD...FETCH_HEAD` before considering `git merge --ff-only FETCH_HEAD`. A bundle carries committed Git history only; it excludes uncommitted files, databases, container images, and model weights.
- Before syncing, inspect `git status` and protect only identified local changes with a named stash when appropriate. Inspect `git stash list` before referring to stash indices. Never automatically run `git stash pop`, `git reset --hard`, or `git clean -fd`; preserve unrelated stashes and local work.
- Treat the host as shared infrastructure. Do not remove/recreate containers, images, or volumes; reset databases; deploy competing stacks; or change the server without explicit authorization and a current inspection. Historical names included `cis-484-capstone-ai-proctor-ollama-1`, `cis-484-capstone-ai-proctor_ollama_models`, and `cis484-ollama-data`; verify before use.
- Never store Wi-Fi passwords, SSH passwords, tokens, private keys, or other credentials in this file, source control, prompts, or generated bundles. Use secrets only through an appropriate secure input path.
