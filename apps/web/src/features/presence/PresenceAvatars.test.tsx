import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, describe, expect, it } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { createStore } from "../../app/store";
import { createPresencePublisher, colorForUser } from "../../crdt/presence";
import { WorkbookDocContext } from "../../crdt/WorkbookDoc";
import { authApi } from "../auth/authApi";
import { PresenceAvatars, initialsOf } from "./PresenceAvatars";

afterEach(cleanup);

const ME = { id: "u-me", email: "me@example.com" };

async function renderAvatars() {
  const store = createStore();
  await store.dispatch(
    authApi.util.upsertQueryData("me", undefined, { user: { ...ME, createdAt: "" } } as never),
  );
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  render(
    <Provider store={store}>
      <WorkbookDocContext.Provider value={{ doc, awareness, readOnly: false }}>
        <PresenceAvatars />
      </WorkbookDocContext.Provider>
    </Provider>,
  );
  return awareness;
}

/** A remote client; returns it so the test can disconnect it. */
function join(awareness: Awareness, user: { id: string; email: string }): Awareness {
  const other = new Awareness(new Y.Doc());
  other.on("update", ({ added, updated, removed }: Record<string, number[]>) =>
    applyAwarenessUpdate(
      awareness,
      encodeAwarenessUpdate(other, [...added!, ...updated!, ...removed!]),
      "remote",
    ),
  );
  act(() => {
    createPresencePublisher(other, user);
  });
  return other;
}

describe("initialsOf", () => {
  it("uses the local part of the email", () => {
    expect(initialsOf("bob@example.com")).toBe("B");
    expect(initialsOf("jane.doe@example.com")).toBe("JD");
    expect(initialsOf("a_b-c@x")).toBe("AB");
    expect(initialsOf("@x")).not.toBe("");
  });
});

describe("PresenceAvatars", () => {
  it("renders nothing while alone", async () => {
    await renderAvatars();
    expect(screen.queryByTestId("presence-avatars")).toBeNull();
  });

  it("shows each collaborator with initials, their color and the email as title", async () => {
    const awareness = await renderAvatars();
    join(awareness, { id: "u-bob", email: "bob@example.com" });
    const avatar = within(screen.getByTestId("presence-avatars")).getByTestId("presence-avatar");
    expect(avatar).toHaveTextContent("B");
    expect(avatar).toHaveAttribute("title", "bob@example.com");
    expect(avatar).toHaveAttribute("data-user-id", "u-bob");
    expect(avatar).toHaveStyle({ backgroundColor: colorForUser("u-bob") });
  });

  it("shows a user once for several tabs, marks the user's own other tab, and removes departures", async () => {
    const awareness = await renderAvatars();
    const bobTab1 = join(awareness, { id: "u-bob", email: "bob@example.com" });
    const bobTab2 = join(awareness, { id: "u-bob", email: "bob@example.com" });
    join(awareness, ME);
    const avatars = screen.getAllByTestId("presence-avatar");
    expect(avatars).toHaveLength(2);
    expect(avatars.map((a) => a.getAttribute("title")).sort()).toEqual([
      "bob@example.com",
      "me@example.com (you, another tab)",
    ]);

    act(() => bobTab1.destroy());
    expect(screen.getAllByTestId("presence-avatar")).toHaveLength(2); // his second tab is still open
    act(() => bobTab2.destroy());
    expect(screen.getAllByTestId("presence-avatar")).toHaveLength(1);
  });

  it("collapses beyond five into +N", async () => {
    const awareness = await renderAvatars();
    for (let i = 0; i < 8; i += 1) join(awareness, { id: `u-${i}`, email: `user${i}@example.com` });
    expect(screen.getAllByTestId("presence-avatar")).toHaveLength(5);
    expect(screen.getByTestId("presence-avatar-more")).toHaveTextContent("+3");
  });
});
