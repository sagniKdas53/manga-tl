import React, { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import ModelOverridesAccordion, {
  type ModelOverridesValue,
  type InheritedModelSettings,
} from "../../components/ModelOverridesAccordion";
import type { SystemSettingsDto } from "../../types";

const settings = {
  ocrProvider: "openrouter",
  ocrModel: "ocr-model-1",
  tlProvider: "openrouter",
  tlModel: "tl-model-1",
  qaProvider: "openrouter",
  qaLlmModel: "qa-llm-1",
  qaVlmModel: "qa-vlm-1",
  qaMode: "auto",
  routingStrategy: "lowest-cost",
  useFallbackModels: true,
  activeProviders: ["openrouter", "gemini"],
  activeOcrProviders: ["local", "openrouter"],
  ocrVlmModelList: ["ocr-model-1"],
  tlLlmModelList: ["tl-model-1"],
  qaLlmModelList: ["qa-llm-1"],
  qaVlmModelList: ["qa-vlm-1"],
} as SystemSettingsDto;

const emptyValue: ModelOverridesValue = {
  ocrProvider: "",
  ocrModel: "",
  tlProvider: "",
  tlModel: "",
  qaProvider: "",
  qaLlmModel: "",
  qaVlmModel: "",
  qaMode: "",
  routingStrategy: "",
  useFallbackModels: null,
};

const Harness = ({
  inherited,
  initialValue,
}: {
  inherited: InheritedModelSettings;
  initialValue?: Partial<ModelOverridesValue>;
}) => {
  const [value, setValue] = useState<ModelOverridesValue>({
    ...emptyValue,
    ...initialValue,
  });
  return (
    <ModelOverridesAccordion
      expanded
      onToggle={() => {}}
      settings={settings}
      inherited={inherited}
      value={value}
      onChange={(field, fieldValue) =>
        setValue((prev) => ({ ...prev, [field]: fieldValue }))
      }
    />
  );
};

const getSelectByLabel = (labelText: string) => {
  const label = screen.getByText(labelText, { selector: "label" });
  const formControl = label.closest(".MuiFormControl-root");
  const combobox = formControl?.querySelector('[role="combobox"]');
  if (!combobox) throw new Error(`No combobox found for label ${labelText}`);
  return combobox as HTMLElement;
};

const getFallbackSelect = () => getSelectByLabel("Use Fallback Models");

describe("ModelOverridesAccordion", () => {
  it("renders the summary with overridden/inherited counts", () => {
    render(<Harness inherited={{}} />);
    expect(screen.getByText("Model Overrides (Optional)")).toBeInTheDocument();
    expect(screen.getByText("0 overridden, 10 inherited")).toBeInTheDocument();
  });

  it("shows the inherited value for non-overridden selects", () => {
    render(<Harness inherited={{ ocrProvider: "local" }} />);
    expect(getSelectByLabel("OCR Provider").textContent).toBe("local");
  });

  it("displays the inherited fallback value (Enabled) instead of a blank select", () => {
    render(<Harness inherited={{ useFallbackModels: true }} />);
    expect(getFallbackSelect().textContent).toBe("Enabled");
  });

  it("displays the inherited fallback value (Disabled) instead of a blank select", () => {
    render(<Harness inherited={{ useFallbackModels: false }} />);
    expect(getFallbackSelect().textContent).toBe("Disabled");
  });

  it("defaults to Enabled when no inherited fallback value is available", () => {
    render(<Harness inherited={{}} />);
    expect(getFallbackSelect().textContent).toBe("Enabled");
  });

  it("only offers Enabled and Disabled options (no Inherit entry)", async () => {
    render(<Harness inherited={{ useFallbackModels: true }} />);

    fireEvent.mouseDown(getFallbackSelect());
    await waitFor(() =>
      expect(screen.getByRole("listbox")).toBeInTheDocument(),
    );

    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Enabled", "Disabled"]);
    expect(
      screen.queryByRole("option", { name: /Inherit/ }),
    ).not.toBeInTheDocument();
  });

  it("sets an explicit override on change and the clear button reverts to inherit", async () => {
    render(<Harness inherited={{ useFallbackModels: true }} />);

    // No clear buttons while nothing is overridden
    expect(document.querySelectorAll('[data-testid="CloseIcon"]').length).toBe(
      0,
    );

    fireEvent.mouseDown(getFallbackSelect());
    await waitFor(() =>
      expect(screen.getByRole("listbox")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("option", { name: "Disabled" }));

    // Override applied: shows the overridden value, chip counts it, X appears
    expect(getFallbackSelect().textContent).toBe("Disabled");
    expect(screen.getByText("1 overridden, 9 inherited")).toBeInTheDocument();
    const clearBtns = document.querySelectorAll('[data-testid="CloseIcon"]');
    expect(clearBtns.length).toBe(1);

    // Clearing reverts to displaying the inherited value
    fireEvent.click(clearBtns[0]);
    expect(getFallbackSelect().textContent).toBe("Enabled");
    expect(screen.getByText("0 overridden, 10 inherited")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="CloseIcon"]').length).toBe(
      0,
    );
  });

  it("respects an explicit override matching the inherited value", async () => {
    render(
      <Harness
        inherited={{ useFallbackModels: true }}
        initialValue={{ useFallbackModels: true }}
      />,
    );
    expect(getFallbackSelect().textContent).toBe("Enabled");
    // Still counts as overridden because the value is explicitly set
    expect(screen.getByText("1 overridden, 9 inherited")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="CloseIcon"]').length).toBe(
      1,
    );
  });

  // AUDIT-F6: these clear-override buttons are icon-only and had no accessible name at all --
  // no aria-label, no Tooltip, no title. A screen reader announced ten identical "button"s.
  it("names each clear-override button", () => {
    render(
      <Harness
        inherited={{}}
        initialValue={{ ocrProvider: "local", qaMode: "llm" }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Clear OCR Provider override" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clear QA Mode override" }),
    ).toBeInTheDocument();
  });
});
