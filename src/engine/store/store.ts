// The record store: one facade over the event log and a repository per record area. Every
// write appends one event and applies it to the projections in the same transaction; reads
// come from the projections and return small pieces.
import type { Database } from "bun:sqlite";
import type { Actor, Role } from "./actor.ts";
import {
  AuditRepository,
  type FeedbackReport,
  type GuardDecision,
  type ImportEntry,
  type NewFeedbackReport,
  type NewGuardDecision,
  type NewImport,
  type NewRoleChange,
  type NewProjectRole,
  type NewSettingChange,
  type ProjectRole,
  ProjectRoleRepository,
  type RoleChange,
  RoleChangeRepository,
  type SettingChange,
  SettingChangeRepository,
} from "./audit.ts";
import { type EntryDetail, EventLog } from "./event-log.ts";
import { type Feature, type FeatureChanges, FeatureRepository, type NewFeature } from "./features.ts";
import {
  type Discussion,
  type Issue,
  type IssueChanges,
  IssueRepository,
  type IssueState,
  type IssueSummary,
  type NewDiscussion,
  type NewIssue,
  type SearchHit,
} from "./issues.ts";
import { MirrorRepository } from "./mirror.ts";
import type { RecordKind, StoredEvent } from "./projections.ts";
import { type NewReview, type NewReviewMark, type NewWaiver, type Review, type ReviewMark, ReviewRepository, type WaiverEntry } from "./reviews.ts";
import { type CheckRun, type CheckRunEnd, type NewCheckRun, type NewRun, type Run, type RunEnd, RunRepository } from "./runs.ts";
import { type NewTask, type Task, type TaskChanges, TaskRepository } from "./tasks.ts";

export type { EntryDetail } from "./event-log.ts";
export * from "./audit.ts";
export * from "./features.ts";
export * from "./issues.ts";
export * from "./mirror.ts";
export * from "./reviews.ts";
export * from "./runs.ts";
export * from "./tasks.ts";

/** The key under which the record names the tmb that wrote its shape. */
export const SHAPE_WRITER_KEY = "shape_writer";
/** The key under which the record keeps the newest event the planner was told of as a change made outside its chat. */
export const PLANNER_TOLD_KEY = "planner_told_through";

/** A tmb as it signs a shape it wrote: its version and the program it ran as. */
export type ShapeWriter = { version: string; program: string };

export class Store {
  private readonly log: EventLog;
  readonly issues: IssueRepository;
  readonly tasks: TaskRepository;
  readonly features: FeatureRepository;
  readonly runs: RunRepository;
  readonly reviews: ReviewRepository;
  readonly settingChanges: SettingChangeRepository;
  readonly roleChanges: RoleChangeRepository;
  readonly projectRoles: ProjectRoleRepository;
  readonly audit: AuditRepository;
  /** The rows mirrored from the remote and where each poll stopped: the syncer writes them, and a change tmb first made on the remote. */
  readonly mirror: MirrorRepository;

  /** Use openStore; it checks the file and its schema version first. */
  constructor(private readonly db: Database) {
    this.log = new EventLog(db);
    this.issues = new IssueRepository(this.log);
    this.tasks = new TaskRepository(this.log);
    this.features = new FeatureRepository(this.log);
    this.runs = new RunRepository(this.log);
    this.reviews = new ReviewRepository(this.log);
    this.settingChanges = new SettingChangeRepository(this.log);
    this.roleChanges = new RoleChangeRepository(this.log);
    this.projectRoles = new ProjectRoleRepository(this.log);
    this.audit = new AuditRepository(this.log);
    this.mirror = new MirrorRepository(this.log);
  }

  close(): void {
    this.db.close();
  }

  /** The tmb that wrote the record's current shape; null for a record from before it was signed. */
  shapeWriter(): ShapeWriter | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(SHAPE_WRITER_KEY) as { value: string } | null;
    if (!row) return null;
    const { version, program } = JSON.parse(row.value) as ShapeWriter;
    return { version, program };
  }

  /** The id of the newest event the planner was told of; null before it was first told. */
  plannerToldThrough(): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(PLANNER_TOLD_KEY) as { value: string } | null;
    return row ? (JSON.parse(row.value) as string) : null;
  }

  /** Marks every event up to `eventId` as told to the planner. Not an event: it changes nothing in the trajectory. */
  setPlannerToldThrough(eventId: string): void {
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(PLANNER_TOLD_KEY, JSON.stringify(eventId));
  }

  /** The pull requests tasks and feature branches opened, by their URLs. */
  pullRequestUrls(): string[] {
    const rows = this.db.query("SELECT pr_url FROM tasks WHERE pr_url IS NOT NULL UNION SELECT pr_url FROM features WHERE pr_url IS NOT NULL").all() as { pr_url: string }[];
    return rows.map((row) => row.pr_url);
  }

  // --- the event log --------------------------------------------------------------------

  history(recordId: string): StoredEvent[] { return this.log.history(recordId); }
  recentEventKinds(limit: number): string[] { return this.log.recentEventKinds(limit); }
  firstEntryAt(): string | null { return this.log.firstEntryAt(); }
  outsideEvents(afterId: string, kinds: readonly RecordKind[]): StoredEvent[] { return this.log.outsideEvents(afterId, kinds); }
  newestEventId(): string | null { return this.log.newestEventId(); }
  rebuildProjections(): void { this.log.rebuildProjections(); }
  transaction<T>(work: () => T): T { return this.log.transaction(work); }
  backdated<T>(at: string, work: () => T): T { return this.log.backdated(at, work); }

  // --- issues and discussions -----------------------------------------------------------

  createIssue(actor: Actor, issue: NewIssue): string { return this.issues.createIssue(actor, issue); }
  updateIssue(actor: Actor, id: string, changes: IssueChanges): void { this.issues.updateIssue(actor, id, changes); }
  getIssue(id: string): Issue | null { return this.issues.getIssue(id); }
  listIssues(filter: { state?: IssueState } = {}): IssueSummary[] { return this.issues.listIssues(filter); }
  appendDiscussion(actor: Actor, discussion: NewDiscussion): string { return this.issues.appendDiscussion(actor, discussion); }
  listDiscussions(issueId: string): Discussion[] { return this.issues.listDiscussions(issueId); }
  newestDecision(issueId: string): Discussion | null { return this.issues.newestDecision(issueId); }
  search(query: string, limit?: number): SearchHit[] { return this.issues.search(query, limit); }

  // --- tasks and feature branches -------------------------------------------------------

  appendTask(actor: Actor, task: NewTask): string { return this.tasks.appendTask(actor, task); }
  updateTask(actor: Actor, id: string, changes: TaskChanges): void { this.tasks.updateTask(actor, id, changes); }
  getTask(id: string): Task | null { return this.tasks.getTask(id); }
  listTasks(state?: string): Task[] { return this.tasks.listTasks(state); }
  listFeatureTasks(featureId: string): Task[] { return this.tasks.listFeatureTasks(featureId); }
  createFeature(actor: Actor, feature: NewFeature): string { return this.features.createFeature(actor, feature); }
  updateFeature(actor: Actor, id: string, changes: FeatureChanges, detail?: EntryDetail): void { this.features.updateFeature(actor, id, changes, detail); }
  getFeature(id: string): Feature | null { return this.features.getFeature(id); }
  findFeature(name: string): Feature | null { return this.features.findFeature(name); }
  listFeatures(state?: string): Feature[] { return this.features.listFeatures(state); }

  // --- runs and check runs --------------------------------------------------------------

  appendRun(actor: Actor, run: NewRun): string { return this.runs.appendRun(actor, run); }
  endRun(actor: Actor, id: string, end: RunEnd = {}): void { this.runs.endRun(actor, id, end); }
  setRunFeature(actor: Actor, id: string, featureId: string): void { this.runs.setRunFeature(actor, id, featureId); }
  getRun(id: string): Run | null { return this.runs.getRun(id); }
  openRuns(role: Role, taskId?: string): Run[] { return this.runs.openRuns(role, taskId); }
  unendedRuns(): Run[] { return this.runs.unendedRuns(); }
  runCostCounts(): { ended: number; withoutCost: number } { return this.runs.runCostCounts(); }
  tasksWithRuns(): Set<string> { return this.runs.tasksWithRuns(); }
  appendCheckRun(actor: Actor, check: NewCheckRun): string { return this.runs.appendCheckRun(actor, check); }
  endCheckRun(actor: Actor, id: string, end: CheckRunEnd): void { this.runs.endCheckRun(actor, id, end); }
  listCheckRuns(taskId: string): CheckRun[] { return this.runs.listCheckRuns(taskId); }
  unendedCheckRuns(): CheckRun[] { return this.runs.unendedCheckRuns(); }

  // --- reviews, waivers and review marks ------------------------------------------------

  appendReview(actor: Actor, review: NewReview): string { return this.reviews.appendReview(actor, review); }
  listRunReviews(runId: string): Review[] { return this.reviews.listRunReviews(runId); }
  listFeatureReviews(featureId: string): Review[] { return this.reviews.listFeatureReviews(featureId); }
  listTaskReviews(taskId: string): Review[] { return this.reviews.listTaskReviews(taskId); }
  listReviews(): Review[] { return this.reviews.listReviews(); }
  recordWaiver(actor: Actor, waiver: NewWaiver): string { return this.reviews.recordWaiver(actor, waiver); }
  listWaivers(): WaiverEntry[] { return this.reviews.listWaivers(); }
  getWaiver(id: string): WaiverEntry | null { return this.reviews.getWaiver(id); }
  recordReviewMark(actor: Actor, mark: NewReviewMark): string { return this.reviews.recordReviewMark(actor, mark); }
  markSent(actor: Actor, id: string, at: string): void { this.reviews.markSent(actor, id, at); }
  listReviewMarks(): ReviewMark[] { return this.reviews.listReviewMarks(); }

  // --- settings history and the audit trail ---------------------------------------------

  recordSettingChange(actor: Actor, change: NewSettingChange): string { return this.settingChanges.recordSettingChange(actor, change); }
  newestSettingChange(key: string, repo: string | null = null, valued = false): SettingChange | null { return this.settingChanges.newestSettingChange(key, repo, valued); }
  listSettingChanges(key?: string): SettingChange[] { return this.settingChanges.listSettingChanges(key); }
  recordRoleChange(actor: Actor, change: NewRoleChange): string { return this.roleChanges.recordRoleChange(actor, change); }
  listRoleChanges(): RoleChange[] { return this.roleChanges.listRoleChanges(); }
  createRole(actor: Actor, role: NewProjectRole): string { return this.projectRoles.createRole(actor, role); }
  deleteRole(actor: Actor, id: string): void { this.projectRoles.deleteRole(actor, id); }
  listRoles(): ProjectRole[] { return this.projectRoles.listRoles(); }
  recordFreeze(actor: Actor, freeze: { reason: string; sessionId?: string | null }): string { return this.audit.recordFreeze(actor, freeze); }
  liftFreeze(actor: Actor, id: string, at: string): void { this.audit.liftFreeze(actor, id, at); }
  recordFeedbackReport(actor: Actor, report: NewFeedbackReport): string { return this.audit.recordFeedbackReport(actor, report); }
  listFeedbackReports(): FeedbackReport[] { return this.audit.listFeedbackReports(); }
  recordImport(actor: Actor, entry: NewImport): string { return this.audit.recordImport(actor, entry); }
  listImports(source: string): ImportEntry[] { return this.audit.listImports(source); }
  appendGuardDecision(actor: Actor, guard: NewGuardDecision): string { return this.audit.appendGuardDecision(actor, guard); }
  listGuardDecisions(): GuardDecision[] { return this.audit.listGuardDecisions(); }
}
