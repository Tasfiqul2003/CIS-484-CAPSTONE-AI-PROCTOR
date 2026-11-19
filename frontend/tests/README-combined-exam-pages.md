# Combined exam pages

## Implemented behavior

- **Exam uploads** is the single sidebar/mobile-menu entry for student rosters, course materials, and questions. All three editors are on the same page, with section links at the top. Existing upload, preview, deletion, summary, and question-draft components are reused.
- In the questions section, Saved Questions follows Import Question Bank, with AI question drafts at the bottom.
- **Time and ODS** contains the standard exam/question limits and ODS assignments. Saving time refreshes the displayed ODS totals without clearing an unfinished EID entry. A refresh waits for an active accommodation save to finish.
- Each editor retains its existing save/upload action and server endpoint. The timing rules, multipliers, and existing-attempt behavior are unchanged.
- The exam ownership check runs before the combined forms mount. Existing dark-mode and roster-photo work is preserved.

| Previous route suffix | Destination |
| --- | --- |
| `/questions` | `/uploads#questions` |
| `/materials` | `/uploads#materials` |
| `/roster` | `/uploads#roster` |
| `/settings/time-scheduling` | `/settings/time-ods#time-limits` |
| `/settings/ods-accommodations` | `/settings/time-ods#ods-accommodations` |

These suffixes follow `/professor/exams/<exam-id>`. Redirects preserve query parameters. Overview shortcuts and the mobile selector use the combined destinations.

## Measured results — 2026-11-19

- TypeScript `tsc --noEmit`: **passed**.
- The frontend `package.json` unit-test script, run with the configured Node runtime: **136 passed**. The first sandbox run blocked esbuild in one fixture; the approved run outside the sandbox passed in full.
- `node frontend/tests/combined-exam-pages-browser.test.mjs`: **11 workflow scenarios passed**. Covers all three uploads/previews, five legacy routes, time/ODS saves and refreshed totals, preservation of unfinished EID text, ownership gating, and dark layouts at 1365, 390, and 320 px. No JavaScript errors or unexpected API/external requests.
- `node frontend/tests/roster-photo-preview-browser.test.mjs`: **8 regression scenarios passed** after adapting its fixtures/selectors to the combined upload page.
- Vite production build: **passed**, retaining the large-bundle warning (~647 kB JavaScript). Generated assets, unit-test output, synthetic screenshots, and actual browser results are under ignored `tests/results/combined-exam-pages-20261119/`.
- `git diff --check`: **passed**.

Browser scripts require the frontend running at localhost:5173 (or `COMBINED_EXAM_TEST_URL` / `ROSTER_PREVIEW_TEST_URL`) and Playwright/Chrome. `AVATAR_NODE_MODULES_PATH` can point to the installed Playwright module directory; `AVATAR_CHROME_PATH` can select Chrome. `COMBINED_EXAM_OUTPUT_DIR` selects the workflow results directory.

These are isolated browser checks with synthetic records and intercepted API calls. They do not write to the live database, process private uploads, call AI services, or demonstrate that any existing backend/schema error is repaired. This change consolidates the frontend workflows.

## Final pull-request validation — 2026-11-19

After consolidating the pages and moving Saved Questions, the final reviewed source passed:

- **155 backend checks** covering roster-photo authorization, image previews, roster access, existing photo-check policy, and timing/ODS behavior.
- **136 frontend unit tests**, TypeScript, and the production build (retaining the ~647 kB JavaScript chunk warning).
- **27 browser behavior/workflow scenarios** across the portal theme, combined exam pages, and roster thumbnail suites, plus **87 dark appearance observations**. The combined-page suite checks the question-panel order. The theme suite tests the production build.
- No browser JavaScript errors or unexpected API/external requests in any of the three suites. Results and synthetic screenshots are in ignored `tests/results/pr-validation-20261119/`.

Temporary photo-skip helper changes and local runtime configuration are excluded from this pull request. These checks do not replace the existing database migration prerequisites; roster photo storage requires `013_student_photo_verification.sql`.
