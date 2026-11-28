// The feedback program's setting (trustmybot/tmb#122). It belongs to the person, not the
// project: it is kept with the program's machine-wide state, one per channel's program, so it
// is asked once per machine. On dev and rc it is on unless turned off, on stable off unless
// turned on; TMB_NO_FEEDBACK=1 and DO_NOT_TRACK=1 turn it off whatever it says.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Channel } from "../program.ts";

export type FeedbackSetting = "on" | "off";
/** How the first run told the person: a notice on dev and rc, a question on stable. */
export type FirstRunHow = "notice" | "question";

/** What the program keeps: the person's choice, if they made one, and when the first run told them. */
export type FeedbackState = { setting: FeedbackSetting | null; firstRun: { at: string; how: FirstRunHow } | null };

/** Why the program is on or off: an environment switch, the stored setting, or the channel's default. */
export type FeedbackReason = "TMB_NO_FEEDBACK" | "DO_NOT_TRACK" | "setting" | "default";

export type FeedbackStatus = { on: boolean; reason: FeedbackReason; channel: Channel; state: FeedbackState };

export const FEEDBACK_FILE = "feedback.json";

export function feedbackFile(stateDir: string): string {
  return path.join(stateDir, FEEDBACK_FILE);
}

/** The stored state; a missing or unreadable file is a program that never told or asked anyone. */
export function readFeedbackState(stateDir: string): FeedbackState {
  try {
    const value = JSON.parse(readFileSync(feedbackFile(stateDir), "utf8")) as Partial<FeedbackState>;
    const setting = value.setting === "on" || value.setting === "off" ? value.setting : null;
    const firstRun =
      value.firstRun && typeof value.firstRun.at === "string" && (value.firstRun.how === "notice" || value.firstRun.how === "question") ? value.firstRun : null;
    return { setting, firstRun };
  } catch {
    return { setting: null, firstRun: null };
  }
}

export function writeFeedbackState(stateDir: string, state: FeedbackState): void {
  const file = feedbackFile(stateDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n");
  renameSync(temp, file);
}

/** The channel's default: on for dev and rc, off for stable. */
export function defaultSetting(channel: Channel): FeedbackSetting {
  return channel === "stable" ? "off" : "on";
}

/** How the first run tells the person: a notice where the program is on by default, a question where it is off. */
export function firstRunHow(channel: Channel): FirstRunHow {
  return defaultSetting(channel) === "on" ? "notice" : "question";
}

/** Only `1` (or `true`) turns a switch on, as DO_NOT_TRACK's convention has it. */
function switchedOn(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/** The environment switch that turns the program off, or null when none does. */
export function offSwitch(env: Record<string, string | undefined>): "TMB_NO_FEEDBACK" | "DO_NOT_TRACK" | null {
  if (switchedOn(env.TMB_NO_FEEDBACK)) return "TMB_NO_FEEDBACK";
  if (switchedOn(env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  return null;
}

export function feedbackStatus(stateDir: string, channel: Channel, env: Record<string, string | undefined>): FeedbackStatus {
  const state = readFeedbackState(stateDir);
  const off = offSwitch(env);
  if (off !== null) return { on: false, reason: off, channel, state };
  if (state.setting !== null) return { on: state.setting === "on", reason: "setting", channel, state };
  return { on: defaultSetting(channel) === "on", reason: "default", channel, state };
}

/** Stores the person's choice; a choice also counts as the first run's, so nothing is asked after it. */
export function setFeedback(stateDir: string, channel: Channel, setting: FeedbackSetting, now: Date = new Date()): FeedbackState {
  const state = readFeedbackState(stateDir);
  const next: FeedbackState = { setting, firstRun: state.firstRun ?? { at: now.toISOString(), how: firstRunHow(channel) } };
  writeFeedbackState(stateDir, next);
  return next;
}

/** Notes that the first run told or asked the person, so it is never said again. */
export function markFirstRun(stateDir: string, channel: Channel, now: Date = new Date()): void {
  const state = readFeedbackState(stateDir);
  if (state.firstRun !== null) return;
  writeFeedbackState(stateDir, { ...state, firstRun: { at: now.toISOString(), how: firstRunHow(channel) } });
}

/** Whether the first run still has to tell or ask: never yet, and no environment switch turned the program off. */
export function firstRunPending(status: FeedbackStatus): boolean {
  return status.state.firstRun === null && status.state.setting === null && status.reason === "default";
}
