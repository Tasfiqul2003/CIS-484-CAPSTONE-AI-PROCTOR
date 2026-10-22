# Avatar and Exam Settings Guide

This guide explains the new and updated features in plain language. Indented bullets show where a control sits inside a page or section. A preview is a test screen; it does not start or grade a real exam.

## Manage Exam

- **Avatar & Interaction Settings** - Open this section to set the avatar's appearance, student choices, and help allowances for an exam.
  - **Save and share exam permissions**
    - **Save Exam Policy** - Save the current rules to the server for this exam. Professor sign-in and ownership are required. Server setup must be completed first.
    - **Load Saved Exam Policy** - Bring the server's saved rules into the editor. If you type while loading is underway, your newer edits are kept.
    - **Share Preview Policy** - Make the current rules available to the connected student preview in this browser. This is separate from saving a draft or saving to the server.
    - **Load Shared Preview Policy** - Bring the last browser-shared rules back into the editor.
    - **Preview exam mode** - Test Practice or Assessed behavior. This is an instructor simulation; it does not change a real exam's mode.
    - **Open shared student preview** - Appears after sharing. Opens the student view using those browser-shared rules.
    - **Open saved policy preview** - Appears after a successful server save. Opens a preview of the saved rules; professor sign-in is required.
    - **Saved and shared revision numbers** - Show which saved version is being used. A stale save is rejected so an older tab cannot silently replace newer rules.
  - **Buttons above and below the settings** - These are editor actions, not another submenu.
    - **Save Local Draft** - Keep a draft in this browser for the current exam and instructor. It does not share rules with the student view or save them to the server.
    - **Reset to Defaults** - Restore starting values in the editor. Choose the appropriate save or share action to keep that reset.
    - **Preview as Student** - Open the instructor's built-in simulation of the current draft. Its extra testing controls are explained later in this guide.
    - **Unsaved changes and error messages** - Show whether edits need saving and identify invalid entries before saving or previewing.
  - **Presentation defaults**
    - **Default avatar** - Choose the starting avatar. Guide is a person icon; Geometric is a diamond icon. These are placeholder graphics.
      - **Upload own avatar photo** - Use a PNG, JPEG, or WebP image up to 1 MB as a still avatar. **Remove avatar photo** removes that selection.
    - **Default background** - Choose the starting backdrop: Neutral, Library, or an uploaded image.
      - **Upload own background photo** - Use a PNG, JPEG, or WebP image up to 1 MB. **Remove background photo** removes that selection.
    - **Default voice** - Choose the professor's Calm or Clear voice preview. Students do not receive a separate voice selector. No actual voice service is activated.
    - **Default speaking speed** - A slider sets the speed multiplier from 0.5x to 2x. 1x is normal, 0.5x is half speed, and 2x is twice normal speed.
    - **Enable animation preview** - Allow the placeholder avatar to move. Uploaded avatar photos remain still.
    - **Reduced motion by default** - Start with less movement. Browser reduced-motion preferences also apply.
    - **Visible avatar state labels** - Keep readable labels such as Idle, Listening, Thinking, Speaking, and Error available. This stays on for accessibility.
  - **Student controls**
    - **Allow students to choose avatar**
      - **Allowed avatar options** - Select which avatars students may choose. The professor's default must be included when student choice is enabled.
    - **Allow students to choose background**
      - **Allowed background options** - Select which backgrounds students may choose. The professor's default must be included.
    - **Allow students to choose speaking speed**
      - **Student speaking speed limits** - Set **Minimum speaking speed** and **Maximum speaking speed** within 0.5x to 2x. The default speed must fit this range.
    - **Comfort options** - Volume, text size, and reduced motion remain student preferences. They do not change questions, grading, or the rubric.
  - **Assistance**
    - **Exact question repeats** - Let students hear or read the same question again without extra information.
    - **Clarification** - Let students request different wording without receiving the answer.
    - **Hints** - Allow a helpful cue when permitted.
    - **Explanations** - Allow an explanation of the concept when permitted.
    - **Correctness feedback** - Allow feedback about a response. If enabled for Assessed mode, it can appear during that simulated exam. The preview uses fixed example text and assigns no grade.
    - **Inside each action's policy**
      - **Availability** - Choose Practice only, Assessed only, or Practice and assessed.
      - **Limit per question** - Type how many uses are allowed: 1 to 10 when the action is enabled. Each action has its own allowance.
    - **Exact question repeats policy and Clarification policy**
      - **Timer continues during repeats or clarification** - Choose whether time should continue during that action. This is a preview rule; no real timer runs here.
    - **Turning an action off** - Its dependent controls are disabled in the instructor editor. The connected student view omits that disallowed action entirely.
  - **Exam behavior**
    - **Follow-up limit per question** - Type 0 to 5 additional questions. Zero turns follow-ups off in this policy.
    - **Question ordering** - Choose Authored order or Randomized.
    - **Response timing** - Choose Use existing exam timing or Fixed response window.
      - **Response window** - Enter the allowed response duration, from 10 seconds to 10 minutes.
      - **Response window unit** - Choose Seconds or Minutes. Changing units preserves the same duration.
    - **Question Bank and Course Materials links** - Open the existing places for professor-authored questions, difficulty, teaching materials, and rubrics.
    - **Separate settings** - These policy values do not currently synchronize with the older Exam Settings section or change live exam delivery.
- **Exam Settings**
  - **AI Questioning**
    - **Follow-Up Questions**
      - **Maximum Follow-Ups Per Question** - Changed from a dropdown to a typed whole number from 1 to 4.
    - **Question difficulty** - The separate difficulty selector was removed. Professors set difficulty in Question Bank.
  - **Two follow-up fields currently exist** - This older 1-to-4 field is separate from the new 0-to-5 policy field under Avatar & Interaction Settings. They are not linked yet.

## Instructor draft simulation

- **Manage Exam > Avatar & Interaction Settings > Preview as Student** - Tests the current draft without sharing or saving it first.
  - **Instructor simulation controls**
    - **Instructor simulation mode** - Switch between Practice and Assessed to inspect availability.
    - **Simulate avatar state** - Try Idle, Listening, Thinking, Speaking, or Error.
    - **Start new synthetic attempt** - Reset this simulator's help-use counts.
  - **Your presentation preferences** - Try volume, text size, reduced motion, and any permitted avatar, background, or speed choices.
  - **Synthetic question and Question assistance** - Try fixed example content and help actions. This instructor diagnostic view can show unavailable actions with explanations.
  - **Professor-set exam behavior** - Review a summary of follow-ups, order, and timing.
  - **Close Student Preview** - Return to the editor. This simulation does not use a microphone, camera, AI model, or actual speech service.

## Student Exams

- **Student Settings Preview** - Opens the page titled Your exam, your presentation preferences.
  - **Which rules are shown** - Opening this link from Student Exams uses a fixed sample. Opening a shared or saved preview link from Manage Exam uses the selected instructor policy.
  - **Student settings** - Opens the settings panel.
    - **Comfort and accessibility**
      - **Volume** - Set 0% to 100%. Audio is simulated in this preview.
      - **Text size** - Choose Standard, Large, or Extra large. Question, assistance, and settings text resize together.
      - **Reduce motion** - Reduce avatar movement. If the browser or instructor already requires reduced motion, it stays on and this switch is omitted.
    - **Presentation** - This section appears only when a change is permitted.
      - **Avatar** - Choose from the professor-approved avatars.
      - **Background** - Choose from the professor-approved backgrounds.
      - **Speaking speed** - Adjust the multiplier within the professor's permitted range.
      - **Restricted choices** - Disallowed controls and their labels are absent. If no presentation changes are allowed, the whole Presentation section is absent.
    - **Save Preferences** - Keep personal preferences in this browser for the selected preview. This does not save instructor rules or help-use counts.
    - **Reset Preferences** - Restore personal defaults. Used assistance allowances are not restored.
    - **Close Settings or Escape** - Close the panel and return keyboard focus to Student settings. Changes take effect immediately; saving keeps them after a reload.
  - **Sample question and response** - Try typing a response. It is not saved, submitted, or evaluated.
  - **Question assistance**
    - **Available action buttons** - Depending on the policy, repeat the question, clarify wording, request a hint, request an explanation, or request correctness feedback. Responses are fixed examples.
    - **X of X remaining badges** - Large, bold purple counts show the allowance before use and update after every use.
    - **Disallowed actions** - No row, button, or placeholder appears.
    - **Used-up allowances** - An allowed action stays visible with 0 remaining and its button is disabled. Changing or resetting preferences does not restore uses.
  - **Policy version and update notice** - Connected previews show their revision. If newer rules are detected, the current preview keeps its starting rules and asks you to restart to apply the update.
  - **Restart preview** - Start a fresh sample attempt, clear the typed response and help-use counts, and load the latest selected policy. Personal preferences are kept where the new rules permit them.
  - **Back to Exams** - Return to the student's exam list.

## Appearance and practical limits

- **Appearance** - New controls use purple accents and the site's existing Arial styling. The student panel supports narrow screens, larger text, and visible keyboard focus.
- **Saving protection** - Invalid entries cannot be saved. Stale policy versions are rejected. New edits made while saved rules are loading are preserved. A failed server request does not silently substitute browser rules.
- **Server setup** - Apply database migration 006 and restart the backend before using Save Exam Policy. The migration has been prepared, but it has not been applied to the project database.
- **Preview scope** - The real student exam, student accounts, class rosters, assignments, and server-tracked assistance usage still require integration. Reloading the sample page starts a new sample attempt. Browser sharing does not grant access to a real exam.
- **Grading** - Professor materials and rubrics control evaluation. AI scores remain provisional, and professors decide final grades.
