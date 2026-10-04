import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../features/auth/authApi", () => ({
  useMeQuery: () => ({ data: { user: { id: "1", email: "user@example.com" } } }),
  useLogoutMutation: () => [vi.fn()],
}));

const { HomePage } = await import("./HomePage");

describe("HomePage", () => {
  it("renders the app heading and the signed-in user's email", () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { name: "Worksheet Clone" })).toBeInTheDocument();
    expect(screen.getByText("Signed in as user@example.com")).toBeInTheDocument();
  });
});
