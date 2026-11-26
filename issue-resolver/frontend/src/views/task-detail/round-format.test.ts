import { describe, expect, it } from "vitest";
import { parseRound, roundAnswerValue } from "./round-format";

const ROUND = `❓ **Q1** - **Scope**: one screen or three?

➡️ One screen first.

❓ **Q2** - **Priority**: ship now or later?

➡️ Ship now.`;

describe("parseRound", () => {
  it("splits a grilling round into questions with recommendations", () => {
    const qs = parseRound(ROUND);
    expect(qs).toHaveLength(2);
    expect(qs?.[0]).toEqual({
      id: "Q1",
      text: "Scope: one screen or three?",
      recommendation: "One screen first.",
    });
    expect(qs?.[1]?.id).toBe("Q2");
    expect(qs?.[1]?.recommendation).toBe("Ship now.");
  });

  it("returns null for text that is not a round", () => {
    expect(parseRound("just some text")).toBeNull();
    expect(parseRound("")).toBeNull();
  });

  it("tolerates missing bold and a missing recommendation", () => {
    const qs = parseRound("❓ Q1 - hello\n❓ Q2 - world\n➡️ yes");
    expect(qs?.[0]).toEqual({ id: "Q1", text: "hello", recommendation: "" });
    expect(qs?.[1]?.recommendation).toBe("yes");
  });

  it("keeps a multi-paragraph question body together", () => {
    const qs = parseRound("❓ **Q1** - **A**: para one\n\npara two\n\n➡️ rec");
    expect(qs?.[0]?.text).toBe("A: para one\n\npara two");
    expect(qs?.[0]?.recommendation).toBe("rec");
  });
});

describe("roundAnswerValue", () => {
  it("keys answers by question id", () => {
    const qs = parseRound(ROUND);
    expect(roundAnswerValue(qs ?? [], ["three", "later"])).toBe(
      "Q1: three\n\nQ2: later",
    );
  });

  it("trims answers and tolerates missing ones", () => {
    const qs = parseRound(ROUND);
    expect(roundAnswerValue(qs ?? [], ["  x  "])).toBe("Q1: x\n\nQ2: ");
  });
});
