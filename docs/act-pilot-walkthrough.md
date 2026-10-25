# Pilot apply walkthrough

This page is for the people who run and approve a pilot change. You do not need to be an engineer. It uses the same words as the screen, so you can read it next to the wizard. The technical runbook for engineers is `docs/act-pilot-apply.md`, and the owner-approved plan is `docs/act-pilot-plan.md`.

## What this is

The pilot takes one reviewed change from preparation, through approval, to a real change in one environment: first DEV, then QA, then PROD. Everything about it is built so that a person is always in charge:

- Nothing happens until a person types an exact phrase, shown on the screen. Nothing is ever filled in for you, and there is no "skip" switch.
- The change that gets applied is exactly the one that was prepared and approved. If anything changed in between, it is refused.
- Approvers sign for one specific change. A signature cannot be reused, and it runs out.
- The owner can stop everything with one file, the emergency stop.
- Agents (the AI helpers) can never start any of this.

The pilot is switched off in this repository until the pilot owner reviews and switches on the pilot rules. If it is off, the wizard tells you so in plain words, and nothing you do can turn it on.

## Who does what

| Person | What they do |
| --- | --- |
| **Operator** | Checks the computer is ready, prepares the change, collects approvals, and applies it. Holds the separate sign-ins on their computer. |
| **Approver** (each one, on their own computer) | Reads what will change, and signs for it with their own key. Never needs the operator's secrets. Production needs two different approvers. |
| **Pilot owner** | Approves the pilot rules, names the approvers, owns the emergency stop, and is the person you call when something needs a review. |

## Choose how to run it: the console or the command line

A change runs entirely one way. You choose when you start, in step 1, and the choice is locked into the prepared change itself. After that:

- A change started in the console can only be approved and applied in the console. The command line refuses it and says why.
- A change started on the command line can only be approved and applied on the command line. The console refuses it and says why.
- Nothing is used up by a refusal for the wrong way. You can finish the change where it started, or start a new one.

Which should you use?

| Choose the console (the wizard) if | Choose the command line if |
| --- | --- |
| You want one step at a time, with the reason for every stop and a next step. | You are comfortable in a terminal and want to script around it. |
| You prefer to see the list of what will change in a table. | You are working on a computer with no browser. |

Both are equally safe. Every check is the same in both.

## Before your first change

These are done once, by the pilot owner and a person at a terminal. They are not part of the wizard.

1. **The pilot rules are approved and switched on** by the pilot owner. The wizard's readiness check says "The pilot is switched on and approved by the owner" when they are.
2. **The one-time check of the deployment tool** is done in a terminal against DEV: `./alz apply qualify --request REQUEST.json --manifest MANIFEST.json`. It is not done in the wizard, because it asks a person to confirm what the cloud's own logs showed. If it was not done, the wizard says "The deployment tool has not passed its one-time check on this computer".
3. **The separate sign-ins** are set up in the environment of whoever starts the console. There are four for Terraform (discovery, state, storage write and apply) and three for CDK. The names and rules are in `docs/act-pilot-apply.md` ("Identities") and `docs/act-pilot-bootstrap.md`. Set them in the terminal first, then start the console from that same terminal. They never go through the web page.
4. **Each approver has a key file** that only they can read, and the pilot owner has listed them for the environments they may approve.

### Starting the console

In your terminal, run `./alz workspace`. It prints the address to open (only on this computer) and a line like:

```
Pilot apply session token (paste it into the wizard once; keep it private; it ends when this console stops):
  <a long string of letters and numbers>
```

That token is your proof that you are the person who started the console. It is shown in the terminal and nowhere else: not on the page, not in the address bar. It changes every time the console starts. If you restart the console, use the new token.

## The walk, step by step

The page shows one step at a time, with a progress bar. If you are an approver, you only see two steps: Choose a path, and Review and approve.

### Unlock the wizard

Paste the session token and choose **Unlock**. A wrong token is refused with "That token was not accepted", and nothing else opens. Reloading the page forgets the token; paste it again.

### Step 1: Choose a path

Pick your part ("I am the operator" or "I am an approver") and how the change will run ("In this web console, with this wizard" or "On the command line, in a terminal"). Then choose **Continue**.

If you choose the command line, the wizard shows the exact commands, in order, to read and copy. Its buttons stay off for this change. If you choose the console, the choice is locked until you choose **Start over**, which clears the choice on this page so you can begin a new change. It does not undo anything that was already applied.

### Step 2: Check readiness

Pick the environment (DEV, QA or PROD) and choose **Run the readiness check**. The check looks at this computer and changes nothing. Each item is "Ready" or "Needs attention". Each item that needs attention says what is wrong and how to fix it. You can continue only when everything is ready. Fix the red items, then choose **Check again**.

The check always ends with a heads-up: whether the separate sign-ins really stay separate has not been proven against the real cloud yet. The first supervised run in DEV is where that gets checked.

### Step 3: Prepare the change

Start with **Get the files ready**: enter your **Project folder** (your Terraform folder, or the `cdk.out` folder) and choose the button. The console reads the owner's pilot rules and your project, and writes the two files the preview needs. It runs nothing and changes nothing. It shows what it found in plain words: the cloud, the build tool, the environment, the account, the place, the project folder, the tool version and the policy version, then fills in both boxes below. These files are made on this computer only; they are not proof that anything works in the cloud. If the AWS CLI version is needed and no earlier check recorded it, a box appears to ask for it. If something is missing that only the owner can supply, the page says so and does not offer a way around it. The raw files are under **Advanced**.

If you already have the files, enter two file locations instead, each with an example under the box: the **Request file** (names the environment, the place to change, and the project folder) and the **Project fingerprint file** (fingerprints the project so it cannot change after you prepare it). Choose **Prepare the change**. This makes a preview of exactly what would change and keeps it locked. It changes nothing yet.

Confirmations you may be asked, one at a time, each in a window that must be answered before you can go on:

| Window | What it means | What you type |
| --- | --- | --- |
| **Confirm where this will run** | You are about to prepare a preview against the environment. Typing the place exactly proves it is the one you mean. | The place, shown in the window, as `account | storage | workspace`. |
| **Allow the project's own code to run** | Preparing the preview runs the project's own code on this computer. Only continue if you trust this project. | `RUN PROJECT CODE`. Only Terraform projects ask this. |
| **Extra confirmation: the storage sign-in** | The pilot rules ask the preparation step to carry the settings of the sign-in that is allowed to write the saved record of your infrastructure. That makes preparing able to write to that record, although it only reads. It stays encrypted. Whether the cloud really signs in as intended is not proven yet. | `EMBED STATE_WRITE` and the environment, for example `EMBED STATE_WRITE DEV`. This window uses the rules file's own name for the sign-in, because that is the phrase you must type. |

Every window shows the phrase and a **Copy** button. The box starts empty. The confirm button stays off until what you typed is exactly the phrase, and a line under the box says, in words, how it differs until then (a space at the end, the wrong capitals, the first character that is different). If you cancel, close the window with Escape, or leave it unanswered for ten minutes, nothing runs and nothing is used up.

### Step 4: Review and approve

**What will change** is shown in plain words ("2 things will be created", "1 thing will be changed in place", and so on), then the full list. You see names and kinds of things, never values. If anything will be deleted, replaced, or stop being tracked, a note says so, and approvers must have read those lines before signing.

How many approvals: DEV and QA need at least one. PROD needs two different people. The owner's pilot rules can require more.

**Operator:** send each approver the review file whose location is shown. It holds no secrets. Each approver signs on their own computer and sends you back an approval file. Enter the locations of the approval files you receive, one per line, then choose **Continue to apply**.

**Approver:** choose "I am an approver" in step 1, enter the **Review file** location, and choose **Show what will change**. Read the list. Then enter **Your key file** location (never uploaded or shown; it must be readable only by you) and **Your approver name**, and choose **Sign my approval**. The window **Sign your approval** asks you to type `APPROVE`, the environment and the first 12 characters of the change ID, for example `APPROVE DEV 0123456789ab`. Your signature allows exactly this change, is valid for a limited time, and can be used once. The wizard then shows where your approval file was saved. Send that file back to the operator. It holds no secrets.

### Step 5: Apply

The boxes are filled in from your earlier steps; check them. Choose **Apply this change...**. The last window, **Apply this change to** the environment, says: "This changes real systems... and there is no undo button here." Type the line shown, for example `APPLY DEV 0123456789ab account | storage | workspace`. That one line carries the environment, the change ID and the place, so what you type is what runs.

Keep the page open and do not stop the console while it applies. The page may pause for a while because the console is busy.

### Step 6: Results

| What the screen says | What happened | What to do |
| --- | --- | --- |
| **Applied** | The change was applied, and the record of it was saved. | Keep the record. For the next environment (QA after DEV, production after QA), prepare a new change with the same release. |
| **Nothing changed** | The step stopped before anything was changed, and nothing was used up. | Read the reason, fix it, and use **Go back and try again**. |
| **Nothing changed, but the approvals are used up** | The change was not applied, but the approvals were already used and cannot be used again. | Fix the cause. Ask each approver to sign again. Then apply the same prepared change. |
| **A person must review this before anything else** | The change may be partly done, or it was stopped half way. | **DO NOT RETRY.** Call the pilot owner now and tell them the time, the environment, and that the apply needs a manual review. Keep the page open and do not start another change until the owner says it is safe. |

## The safety stops, in plain words

Every stop shows "Why it stopped" and "What to do next". At the Advanced and Expert levels there is also a **Details** disclosure with the reference code, for the person helping you. At the Beginner level, **Copy a note for the pilot owner** puts the code and message on your clipboard.

| Stop | What it means | What to do |
| --- | --- | --- |
| The pilot is switched off | The owner has not switched on and approved the pilot rules. | Ask the pilot owner. You cannot do this yourself. |
| The emergency stop is on | A stop file exists, so every change is blocked. | Only the pilot owner removes it. |
| Started the other way | The change was started in the console or on the command line and must finish there. Nothing is used up. | Finish it where it started, or start a new one. |
| Not enough approvals, or a wrong one | Production needs two different people. An approval might be expired, already used, signed for another change or environment, or from someone not on the list. | Ask the right approver to sign again. |
| Out of date | The cloud changed after the preview was made. Nothing was applied. | Prepare a new preview and collect new approvals. |
| A file changed | A file changed after it was prepared or approved. | Do not use it. Prepare a new change and tell the pilot owner if you did not change anything yourself. |
| Release not in the earlier environment | QA needs DEV to have succeeded with this release, and production needs QA. | Finish the earlier environment first. |
| The deployment tool has not passed its one-time check | See "Before your first change". | A person runs it in a terminal. |
| Sign-in problems | A sign-in is missing, two are the same, or one points at the wrong account. | Fix it in the terminal where the console was started, restart the console, and check readiness again. |

## When something fails

1. Read "Why it stopped" and "What to do next".
2. If the screen says **DO NOT RETRY**, do not. Call the pilot owner.
3. If it says nothing changed, fix the cause and go back. Nothing was used up unless it says the approvals were.
4. If you are not sure what happened, treat it as needing a review and call the pilot owner.
5. A prepared change can be applied once. Once it has run, even partly, it is closed. A new attempt always means a new preview and new approvals.

## Glossary

| Word on the screen | Meaning |
| --- | --- |
| Pilot rules | The owner-approved file that names the places, approvers and approvals needed. Changing it means a new review. |
| Environment | DEV, QA or PROD. A release goes DEV, then QA, then PROD. |
| Prepared change | The locked preview of exactly what would change. It is encrypted and applied as-is. |
| Change ID | The first 12 characters that identify one prepared change, shown so people can check they mean the same one. |
| Review file | The file you send approvers. It lists what will change and holds no secrets. |
| Approval file | An approver's signed permission for one prepared change. |
| Separate sign-ins | Different accounts for reading, saving records, and applying, so none can do the others' jobs. |
| Session token | The long string printed in your terminal when the console starts. It unlocks the wizard for the person who started it. |
| Emergency stop | A file the owner creates to block every change. |
| Details | The disclosure with the reference code, for the person helping you. |

## The command-line path

The commands, in order. Operators run 1, 2, 3 and 5. Each approver runs 4 on their own computer with their own key.

1. `./alz apply preflight --environment DEV`
2. `./alz apply prepare --environment DEV --project PROJECT_FOLDER` (prints the request and manifest locations to use next)
3. `./alz apply seal --request REQUEST.json --manifest MANIFEST.json`
4. `./alz apply approve --bundle REVIEW_FILE.json --key APPROVER_KEY.pem --approver NAME`
5. `./alz apply apply --request REQUEST.json --manifest MANIFEST.json --sealed LOCKED_CHANGE --approval APPROVAL.json`
6. `./alz apply status --sealed LOCKED_CHANGE` (anyone, afterward)

The phrases are the same as in the console. The technical reference for each command, its exit codes and its files is `docs/act-pilot-apply.md`.
