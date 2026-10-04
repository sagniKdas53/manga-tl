import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import EditIcon from "@mui/icons-material/Edit";
import CardFooter from "../../components/CardFooter";

describe("CardFooter", () => {
  it("runs an action without also opening the card it sits in", () => {
    const openCard = vi.fn();
    const edit = vi.fn();
    render(
      <div onClick={openCard}>
        <CardFooter
          info={[]}
          actions={[
            { title: "Edit Chapter", icon: <EditIcon />, onClick: edit },
          ]}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Chapter" }));
    expect(edit).toHaveBeenCalledTimes(1);
    expect(openCard).not.toHaveBeenCalled();
  });
});
