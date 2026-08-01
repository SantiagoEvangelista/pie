import assert from "node:assert/strict";
import test from "node:test";

import { completedToolBatch, latestUserIndex, snapToProtocolBoundary } from "./logic.ts";

test("detects completed tool batches from Pi turn_end events", () => {
	assert.equal(completedToolBatch({ toolResults: [{}] }), true);
	assert.equal(completedToolBatch({ toolResults: [] }), false);
	assert.equal(completedToolBatch({}), false);
});

test("snaps emergency cuts to assistant boundaries within long tool turns", () => {
	const messages = [
		{ role: "user" },
		{ role: "assistant" },
		{ role: "toolResult" },
		{ role: "assistant" },
		{ role: "toolResult" },
	];
	assert.equal(snapToProtocolBoundary(messages, 2), 3);
	assert.equal(latestUserIndex(messages), 0);
});
