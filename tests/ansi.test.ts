import { describe, expect, test } from "bun:test";
import {
  classifyLevelColor,
  parseAnsi,
  parseTimestamp,
} from "../src/components/servers/ansi";

describe("parseAnsi", () => {
  test("returns plain text as a single unstyled segment", () => {
    expect(parseAnsi("hello")).toEqual([{ text: "hello", style: {} }]);
  });

  test("maps ANSI colors and strips the escape codes", () => {
    const segments = parseAnsi("\u001b[32mok\u001b[0m plain");
    expect(segments[0].text).toBe("ok");
    expect(segments[0].style.color).toBe("#4cf5a0");
    expect(segments[1].text).toBe(" plain");
    expect(segments[1].style.color).toBeUndefined();
  });

  test("bright codes map like standard codes", () => {
    const segments = parseAnsi("\u001b[91mboom\u001b[0m");
    expect(segments[0].style.color).toBe("#f54c4c");
  });

  test("bold and dim flags are tracked", () => {
    const segments = parseAnsi("\u001b[1;2mx");
    expect(segments[0].style.bold).toBe(true);
    expect(segments[0].style.dim).toBe(true);
  });

  test("unknown SGR codes leave the text intact", () => {
    const segments = parseAnsi("\u001b[38;5;200mcolor\u001b[0m");
    expect(segments.map((s) => s.text).join("")).toBe("color");
  });
});

describe("parseTimestamp", () => {
  test("splits a bracketed leading stamp", () => {
    expect(parseTimestamp("[12:34:56] hello")).toEqual({
      prefix: "[12:34:56] ",
      rest: "hello",
    });
  });

  test("accepts unstamped hour:minute forms", () => {
    expect(parseTimestamp("12:34 boot")).toEqual({
      prefix: "12:34 ",
      rest: "boot",
    });
  });

  test("leaves lines without a stamp untouched", () => {
    expect(parseTimestamp("hello")).toEqual({ prefix: "", rest: "hello" });
  });
});

describe("classifyLevelColor", () => {
  test("error wins over warn", () => {
    expect(classifyLevelColor("warn: error happened")).toBe("#f54c4c");
  });

  test("success keywords tint green", () => {
    expect(classifyLevelColor("Server started")).toBe("#4cf5a0");
  });

  test("neutral lines are not tinted", () => {
    expect(classifyLevelColor("tick")).toBe("inherit");
  });

  test("timestamps do not skew detection", () => {
    expect(classifyLevelColor("[12:00:00] error: boom")).toBe("#f54c4c");
  });
});
