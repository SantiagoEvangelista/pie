export const FOOTER_ACTIONS = ["workflows", "subagents"] as const;

export type FooterAction = (typeof FOOTER_ACTIONS)[number];
export type FooterNavigationIntent =
  | "left"
  | "right"
  | "up"
  | "cancel"
  | "confirm";

export interface FooterNavigationResult {
  action?: FooterAction;
  returnToEditor: boolean;
  selectionChanged: boolean;
}

export class FooterActionSelection {
  private index = 0;

  current(): FooterAction {
    return FOOTER_ACTIONS[this.index]!;
  }

  move(delta: -1 | 1): FooterAction {
    this.index =
      (this.index + delta + FOOTER_ACTIONS.length) % FOOTER_ACTIONS.length;
    return this.current();
  }

  handle(intent: FooterNavigationIntent): FooterNavigationResult {
    if (intent === "left" || intent === "right") {
      this.move(intent === "left" ? -1 : 1);
      return {
        returnToEditor: false,
        selectionChanged: true,
      };
    }
    if (intent === "confirm") {
      return {
        action: this.current(),
        returnToEditor: true,
        selectionChanged: false,
      };
    }
    return {
      returnToEditor: true,
      selectionChanged: false,
    };
  }
}
