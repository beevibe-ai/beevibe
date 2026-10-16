import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TextField } from "./text-field";

describe("TextField", () => {
  it("ties the label to the input so clicking the label focuses it", async () => {
    render(<TextField id="email" label="Email" type="email" />);
    await userEvent.click(screen.getByText("Email"));
    expect(document.activeElement).toBe(screen.getByLabelText("Email"));
  });

  it("forwards input attributes to the input itself", () => {
    render(
      <TextField id="password" label="Password" type="password" autoComplete="new-password" />,
    );
    const input = screen.getByLabelText("Password");
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
  });

  it("reports edits to the caller", async () => {
    const onChange = vi.fn();
    render(<TextField id="name" label="Name" value="" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Name"), "A");
    expect(onChange).toHaveBeenCalled();
  });

  it("puts caller spacing on the wrapper, not the input", () => {
    const { container } = render(<TextField id="email" label="Email" className="mt-3" />);
    expect((container.firstChild as HTMLElement).className).toBe("mt-3");
    expect(screen.getByLabelText("Email").className).not.toContain("mt-3");
  });

  it("extends the input class without dropping the shared one", () => {
    render(<TextField id="key" label="Key" inputClassName="font-mono" />);
    const cls = screen.getByLabelText("Key").className;
    expect(cls).toContain("font-mono");
    expect(cls).toContain("border-border");
  });
});
