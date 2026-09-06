import { describe, expect, it } from "vitest";
import type { Locator, Page } from "playwright";
import { ChatGPTInteraction } from "../src/browser-worker/interaction/chatgpt-interaction.js";
import { ComposerLocator } from "../src/browser-worker/interaction/composer-locator.js";

type PageMode = "submitted" | "submit-failed" | "missing" | "auth" | "no-send";

class FakeLocator {
  public value = "";
  public visible = true;
  public enabled = true;
  public editable = true;
  public matches = 1;
  public clickAction: (() => void) | undefined;

  public async count(): Promise<number> { return this.matches; }
  public nth(): FakeLocator { return this; }
  public async isVisible(): Promise<boolean> { return this.visible; }
  public async isEnabled(): Promise<boolean> { return this.enabled; }
  public async isEditable(): Promise<boolean> { return this.editable; }
  public async fill(value: string): Promise<void> { this.value = value; }
  public async inputValue(): Promise<string> { return this.value; }
  public async textContent(): Promise<string> { return this.value; }
  public async click(): Promise<void> { this.clickAction?.(); }
}

class FakePage {
  public readonly input = new FakeLocator();
  public readonly send = new FakeLocator();
  public readonly userMessages = new FakeLocator();
  public readonly auth = new FakeLocator();
  public mode: PageMode;
  public filledMessage = "";

  public constructor(mode: PageMode) {
    this.mode = mode;
    this.input.fill = async (value: string): Promise<void> => {
      this.filledMessage = value;
      this.input.value = value;
    };
    this.send.clickAction = (): void => {
      if (this.mode === "submitted") {
        this.input.value = "";
        this.userMessages.matches += 1;
      }
    };
  }

  public url(): string {
    return this.mode === "auth"
      ? "https://chatgpt.com/auth/login"
      : "https://chatgpt.com/c/conversation-001";
  }

  public locator(selector: string): FakeLocator {
    if (selector === '[data-message-author-role="user"]') return this.userMessages;
    if (selector.includes("/auth/login") || selector.includes("/login")
      || selector.includes("login-button")) {
      this.auth.matches = this.mode === "auth" ? 1 : 0;
      return this.auth;
    }
    if (selector.startsWith("textarea") || selector.includes("contenteditable")
      || selector.includes("role=\"textbox\"")) {
      this.input.matches = this.mode === "missing" ? 0 : 1;
      return this.input;
    }
    if (selector.startsWith("button")) {
      this.send.matches = this.mode === "no-send" ? 0 : 1;
      return this.send;
    }
    return new FakeLocator();
  }
}

function page(mode: PageMode): Page {
  return new FakePage(mode) as unknown as Page;
}

describe("ChatGPTInteraction", () => {
  it("fills multiline Unicode text and confirms a submitted user message", async () => {
    const fake = new FakePage("submitted");
    const message = "请检查这次修改。\nReview Context\n中文内容";

    await expect(new ChatGPTInteraction({
      confirmationTimeoutMs: 10,
      confirmationPollMs: 1,
    }).submitMessage(fake as unknown as Page, message)).resolves.toEqual({ status: "SUBMITTED" });
    expect(fake.filledMessage).toBe(message);
  });

  it("reports authentication and missing composer states", async () => {
    await expect(new ChatGPTInteraction().submitMessage(page("auth"), "review"))
      .resolves.toMatchObject({ status: "AUTH_REQUIRED" });
    await expect(new ChatGPTInteraction().submitMessage(page("missing"), "review"))
      .resolves.toMatchObject({ status: "COMPOSER_NOT_FOUND" });
    await expect(new ChatGPTInteraction().submitMessage(page("no-send"), "review"))
      .resolves.toMatchObject({ status: "COMPOSER_NOT_FOUND" });
  });

  it("does not report success when the page does not confirm submission", async () => {
    await expect(new ChatGPTInteraction({ confirmationTimeoutMs: 0 })
      .submitMessage(page("submit-failed"), "review"))
      .resolves.toMatchObject({ status: "SUBMIT_FAILED" });
  });

  it("keeps selectors in the dedicated Composer Locator", async () => {
    const fake = new FakePage("submitted");
    await expect(new ComposerLocator().locate(fake as unknown as Page))
      .resolves.toMatchObject({ status: "READY" });
  });
});
