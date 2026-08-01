/** True after an assistant turn executed at least one tool. */
export function completedToolBatch(event: { toolResults?: readonly unknown[] }): boolean {
	return (event.toolResults?.length ?? 0) > 0;
}

type RoleMessage = { role: string };

/** Tool results cannot begin a valid model-visible history slice. */
export function snapToProtocolBoundary(messages: readonly RoleMessage[], rawIndex: number): number {
	let index = rawIndex;
	while (index < messages.length) {
		const role = messages[index]?.role;
		if (role === "user" || role === "assistant") return index;
		index++;
	}
	return messages.length;
}

export function latestUserIndex(messages: readonly RoleMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}
