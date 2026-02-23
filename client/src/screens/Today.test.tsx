import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import Today from "./Today";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockLoadDayEntries = vi.fn();
const mockFetchAndDecrypt = vi.fn().mockResolvedValue(undefined);
const mockSubmitEntry = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/store", () => ({
  loadDayEntries: (...args: unknown[]) => mockLoadDayEntries(...args),
  fetchAndDecryptEntries: (...args: unknown[]) => mockFetchAndDecrypt(...args),
  isPaired: () => false,
  submitEntry: (...args: unknown[]) => mockSubmitEntry(...args),
}));

vi.mock("@solidjs/router", () => ({
  useParams: () => ({}), // no dayId param → uses today
  useNavigate: () => vi.fn(),
}));

vi.mock("../components/Nav", () => ({
  default: () => null,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function noEntries() {
  mockLoadDayEntries.mockResolvedValue({ entries: [] });
}

function onlyPartnerWrote() {
  mockLoadDayEntries.mockResolvedValue({
    entries: [{ author: "partner", payload: "partner's words", dayId: "2026-02-23", timestamp: "" }],
  });
}

function onlyIWrote() {
  mockLoadDayEntries.mockResolvedValue({
    entries: [{ author: "me", payload: "my words", dayId: "2026-02-23", timestamp: "" }],
  });
}

function bothWrote() {
  mockLoadDayEntries.mockResolvedValue({
    entries: [
      { author: "me", payload: "my words", dayId: "2026-02-23", timestamp: "" },
      { author: "partner", payload: "partner's words", dayId: "2026-02-23", timestamp: "" },
    ],
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure dev mode is off
  sessionStorage.removeItem("devMode");
});

describe("Today — mutual disclosure states", () => {
  test("shows compose when neither has written", async () => {
    noEntries();
    render(() => <Today />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("What's on your heart today?")).toBeInTheDocument()
    );
    expect(screen.queryByText("Waiting for your partner...")).not.toBeInTheDocument();
  });

  test("shows compose + partner banner when partner wrote but I haven't", async () => {
    onlyPartnerWrote();
    render(() => <Today />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("What's on your heart today?")).toBeInTheDocument()
    );
    expect(screen.getByText("Your partner has written today")).toBeInTheDocument();
  });

  test("shows veil when I wrote but partner hasn't", async () => {
    onlyIWrote();
    render(() => <Today />);

    await waitFor(() =>
      expect(screen.getByText("Waiting for your partner...")).toBeInTheDocument()
    );
    expect(screen.queryByPlaceholderText("What's on your heart today?")).not.toBeInTheDocument();
  });

  test("shows both entries when both have written", async () => {
    bothWrote();
    render(() => <Today />);

    await waitFor(() => expect(screen.getByText("You")).toBeInTheDocument());
    expect(screen.getByText("Partner")).toBeInTheDocument();
    expect(screen.getByText("my words")).toBeInTheDocument();
    expect(screen.getByText("partner's words")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for your partner...")).not.toBeInTheDocument();
  });
});

describe("Today — composing and submitting", () => {
  test("Send button is disabled with empty textarea", async () => {
    noEntries();
    render(() => <Today />);

    await waitFor(() => screen.getByPlaceholderText("What's on your heart today?"));
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  test("Send button enables after typing", async () => {
    noEntries();
    render(() => <Today />);

    const textarea = await screen.findByPlaceholderText("What's on your heart today?");
    await userEvent.type(textarea, "hello");

    expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
  });

  test("submitting calls submitEntry and updates UI", async () => {
    noEntries();
    render(() => <Today />);

    const textarea = await screen.findByPlaceholderText("What's on your heart today?");
    await userEvent.type(textarea, "I love you");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(mockSubmitEntry).toHaveBeenCalledWith("I love you", expect.any(String)));
    await waitFor(() => expect(screen.getByText("Waiting for your partner...")).toBeInTheDocument());
  });

  test("shows character count while typing", async () => {
    noEntries();
    render(() => <Today />);

    const textarea = await screen.findByPlaceholderText("What's on your heart today?");
    await userEvent.type(textarea, "hello");

    expect(screen.getByText("5 characters")).toBeInTheDocument();
  });
});
