/**
 * The student path: three guided tasks on bundled fixtures. A student never reaches a cloud account, a secret,
 * an approval or a change run. Each task names one demo scenario that the repository already runs offline.
 */
export type LearnRole = "student";

export type FixtureScenario = {
  readonly provider: "aws" | "azure";
  readonly engine: "terraform" | "pulumi";
  readonly scenario: "greenfield" | "brownfield" | "unknown";
};

export type LearnTask = {
  readonly id: "look" | "find-risk" | "explain";
  readonly title: string;
  readonly summary: string;
  readonly fixture: FixtureScenario;
};

/** The only scenarios the student path may run. Each matches an existing offline npm script or demo option. */
export const STUDENT_TASKS: readonly LearnTask[] = [
  {
    id: "look",
    title: "Look at a small landing zone",
    summary: "See how an AWS landing zone is described before anything changes.",
    fixture: { provider: "aws", engine: "terraform", scenario: "brownfield" },
  },
  {
    id: "find-risk",
    title: "Find one risk",
    summary: "Watch the system refuse a change it cannot prove is safe.",
    fixture: { provider: "aws", engine: "terraform", scenario: "unknown" },
  },
  {
    id: "explain",
    title: "Explain one change",
    summary: "Build a fresh Azure design and describe it in your own words.",
    fixture: { provider: "azure", engine: "pulumi", scenario: "greenfield" },
  },
];

export type StudentProgress = { readonly done: readonly LearnTask["id"][] };

export function startProgress(): StudentProgress {
  return { done: [] };
}

/** Marks a task finished. Unknown ids and repeats change nothing. */
export function completeTask(progress: StudentProgress, id: string): StudentProgress {
  const task = STUDENT_TASKS.find((candidate) => candidate.id === id);
  if (!task || progress.done.includes(task.id)) return progress;
  return { done: [...progress.done, task.id] };
}

/** The next unfinished task, or undefined once all three are done. */
export function nextTask(progress: StudentProgress): LearnTask | undefined {
  return STUDENT_TASKS.find((task) => !progress.done.includes(task.id));
}

/** The arguments `./alz demo` takes for a task. Only fixture values are ever produced. */
export function demoArguments(task: LearnTask): string[] {
  return [task.fixture.provider, task.fixture.engine, task.fixture.scenario];
}
