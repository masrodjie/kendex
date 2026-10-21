import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { clearPackageConfigCache } from "../extensions/package-config.ts";
import sessionBridge from "../extensions/session-bridge.ts";

import { runCli } from "./lib/cli-fixture.ts";
import { type EventHandler, fakeCtx, fakePi, shutdownBridge, writeBridgeSettings } from "./lib/bridge-fixture.ts";

// A host such as pi-web-ui keeps one Pi runtime per open conversation in a
// single process, so the extension is installed once per runtime and several
// bridges share one pid.

let dir = "";
const saved = { cwd: "", piDir: undefined as string | undefined, bridgeDir: undefined as string | undefined };
const running: Map<string, EventHandler>[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-session-bridge-multi-"));
	saved.cwd = process.cwd();
	saved.piDir = process.env.PI_CODING_AGENT_DIR;
	saved.bridgeDir = process.env.PI_BRIDGE_DIR;
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	clearPackageConfigCache();
	process.env.PI_BRIDGE_DIR = join(dir, "bridge");
	writeBridgeSettings(dir);
	process.chdir(dir);
});

afterEach(async () => {
	for (const handlers of running.splice(0)) await shutdownBridge(handlers, dir);
	process.chdir(saved.cwd);
	if (saved.piDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved.piDir;
	clearPackageConfigCache();
	if (saved.bridgeDir === undefined) delete process.env.PI_BRIDGE_DIR;
	else process.env.PI_BRIDGE_DIR = saved.bridgeDir;
	rmSync(dir, { recursive: true, force: true });
});

function sessionCtx(sessionId: string): ExtensionContext {
	return { ...fakeCtx(dir), sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
}

async function startSession(sessionId: string): Promise<Map<string, EventHandler>> {
	const { pi, handlers } = fakePi();
	sessionBridge(pi);
	await handlers.get("session_start")?.({ reason: "test" }, sessionCtx(sessionId));
	running.push(handlers);
	return handlers;
}

async function stopSession(handlers: Map<string, EventHandler>): Promise<void> {
	running.splice(running.indexOf(handlers), 1);
	await shutdownBridge(handlers, dir);
}

function bridgePaths(stem: string) {
	const bridgeDir = process.env.PI_BRIDGE_DIR!;
	return { socket: join(bridgeDir, `pi-${stem}.sock`), registry: join(bridgeDir, "instances", `${stem}.json`) };
}

function registrySession(stem: string): string {
	return JSON.parse(readFileSync(bridgePaths(stem).registry, "utf8")).sessionId;
}

async function listedSessions(): Promise<string[]> {
	const result = await runCli(["list", "--json"]);
	expect(result.code).toBe(0);
	return (JSON.parse(result.stdout) as { sessionId: string }[]).map((info) => info.sessionId).sort();
}

test("two sessions in one process each keep their own socket and registry entry", async () => {
	await startSession("chat-a");
	await startSession("chat-b");

	const first = bridgePaths(String(process.pid));
	const second = bridgePaths(`${process.pid}-1`);
	expect(existsSync(first.socket) && existsSync(second.socket)).toBe(true);
	expect(registrySession(String(process.pid))).toBe("chat-a");
	expect(registrySession(`${process.pid}-1`)).toBe("chat-b");
	expect(await listedSessions()).toEqual(["chat-a", "chat-b"]);
}, 30_000);

test("shutting one session down leaves the other session's bridge in place", async () => {
	const a = await startSession("chat-a");
	await startSession("chat-b");

	await stopSession(a);

	const first = bridgePaths(String(process.pid));
	const second = bridgePaths(`${process.pid}-1`);
	expect(existsSync(first.socket) || existsSync(first.registry)).toBe(false);
	expect(existsSync(second.socket) && existsSync(second.registry)).toBe(true);
	expect(await listedSessions()).toEqual(["chat-b"]);
}, 30_000);

test("a freed slot is reused without touching the running session", async () => {
	const a = await startSession("chat-a");
	await startSession("chat-b");
	await stopSession(a);

	await startSession("chat-c");

	expect(registrySession(String(process.pid))).toBe("chat-c");
	expect(registrySession(`${process.pid}-1`)).toBe("chat-b");
	expect(await listedSessions()).toEqual(["chat-b", "chat-c"]);
}, 30_000);
