// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import App from "../web/App.tsx";

afterEach(cleanup);

const renderApp = () => render(<App today="2026-11-22" />);

describe("calculator UI", () => {
  it("shows the textbook $1,000 / 10% / 12-month plan by default", () => {
    renderApp();
    expect(screen.getByTestId("regular").textContent).toBe("$87.92");
    expect(screen.getByTestId("interest").textContent).toBe("$54.99");
    expect(screen.getByTestId("total").textContent).toBe("$1,054.99");
    const rows = within(screen.getByRole("region", { name: "Payment schedule" })).getAllByRole("row");
    expect(rows).toHaveLength(13); // header + 12
  });

  it("Pay in 4 locks APR to zero and schedules biweekly from the purchase date", () => {
    renderApp();
    fireEvent.click(screen.getByRole("radio", { name: "Pay in 4" }));
    expect((screen.getByLabelText("APR (%)") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("regular").textContent).toBe("$250.00");
    expect(screen.getByTestId("interest").textContent).toBe("$0.00");
    const table = screen.getByRole("region", { name: "Payment schedule" });
    expect(within(table).getByText("2026-11-22")).toBeTruthy();
    expect(within(table).getByText("2027-01-03")).toBeTruthy();
  });

  it("refund simulator takes the refund off the last payment and reports cash back", () => {
    renderApp();
    fireEvent.click(screen.getByRole("radio", { name: "Pay in 4" }));
    fireEvent.change(screen.getByLabelText("Refund ($)"), { target: { value: "300" } });
    expect(screen.getByTestId("cashback").textContent).toContain("$0.00");
    fireEvent.change(screen.getByLabelText("Payments already made"), { target: { value: "3" } });
    expect(screen.getByTestId("cashback").textContent).toContain("$50.00");
    const after = screen.getByRole("region", { name: "Schedule after refund" });
    expect(within(after).getAllByText("paid")).toHaveLength(3);
  });

  it("shows a readable error for a bad amount instead of crashing", () => {
    renderApp();
    fireEvent.change(screen.getByLabelText("Purchase amount ($)"), { target: { value: "12.345" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Not a dollar amount/);
    fireEvent.change(screen.getByLabelText("Purchase amount ($)"), { target: { value: "5" } });
    expect(screen.getByRole("alert").textContent).toMatch(/at least \$1 per installment/);
  });

  it("early payoff quote matches the schedule balance", () => {
    renderApp();
    expect(screen.getByTestId("payoff").textContent).toMatch(/Pay \$7\d\d\.\d\d to close/);
    fireEvent.change(screen.getByLabelText("Payments already made"), { target: { value: "12" } });
    expect(screen.getByTestId("payoff").textContent).toContain("Pay $0.00");
  });
});
