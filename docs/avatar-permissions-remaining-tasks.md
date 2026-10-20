# Avatar permissions: requirements for related work

The instructor editor and student previews now share versioned exam policies. The professor-owned policy API and database migration are implemented. Real student access and exam-attempt enforcement require the integrations below.

- **Database setup:** apply migration `006_exam_avatar_policy.sql` through the normal migration process and validate it against PostgreSQL. Restart the backend to register the policy API. This work tested persistence against isolated SQLite; the existing project database was not changed.
- **Roster and enrollment:** when creating roster tables, link each class to its professor and each enrollment to an authenticated student. Ensure the student portal can resolve only that student's enrolled classes, assigned exams, and permitted policy information.
- **Exam assignments and login:** when building assignments, connect exams to eligible classes or individual students. Derive identity from the authenticated session and check eligibility before returning policy data or starting an attempt. Return a student-facing policy without professor-only evaluation information.
- **Actual exam integration:** load the assigned exam's authoritative mode and policy before showing controls. Reconcile saved preferences with permitted choices, hide disallowed settings, and retain volume, text size, readable state labels, and reduced motion.
- **Attempt persistence:** save the policy revision and snapshot when an attempt starts. Apply later instructor edits to new attempts. Preserve the active attempt's rules across reloads and reconnections.
- **Assistance enforcement:** store usage by attempt, question, and action. Validate permissions, mode, limits, and timer behavior on the server. Handle retries and concurrent requests atomically so they cannot grant extra uses.
- **Approved exceptions:** when adding accommodations, record the student, exam, approving role, and override scope. Define precedence without allowing students to modify their own assessment rules.
- **Connected workflow tests:** verify professor ownership, student eligibility, cross-student/cross-exam denial, changed enrollment, stale policies, restricted saved preferences, reloads, and concurrent assistance requests using synthetic data.

Browser preview IDs and local storage are demonstration tools, not authentication or permission enforcement.
