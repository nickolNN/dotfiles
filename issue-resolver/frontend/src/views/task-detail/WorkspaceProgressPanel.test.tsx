import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceProgressStatus } from "@issue-resolver/shared";
import WorkspaceProgressPanel from "./WorkspaceProgressPanel";
import type { WorkspaceProgressBoard } from "./types";

function board(overrides: Partial<WorkspaceProgressBoard> = {}): WorkspaceProgressBoard {
  return {
    steps: [
      {
        key: "cloning:owner/repo",
        step: "cloning",
        repo: "owner/repo",
        status: WorkspaceProgressStatus.done,
      },
    ],
    finished: false,
    fading: false,
    dismissed: false,
    ...overrides,
  };
}

afterEach(cleanup);

describe("WorkspaceProgressPanel", () => {
  it("renders one row per workspace step", () => {
    render(<WorkspaceProgressPanel progress={board()} onFinished={vi.fn()} />);

    expect(screen.getByText("Подготовка проектов")).toBeInTheDocument();
    expect(screen.getByText("Клонирование owner/repo")).toBeInTheDocument();
  });

  it("keeps the panel mounted when a row animation ends", () => {
    const onFinished = vi.fn();
    render(<WorkspaceProgressPanel progress={board()} onFinished={onFinished} />);

    fireEvent.animationEnd(screen.getByTestId("workspace-step"));

    expect(onFinished).not.toHaveBeenCalled();
  });

  it("reports completion when the fade animation of the panel itself ends", () => {
    const onFinished = vi.fn();
    render(
      <WorkspaceProgressPanel
        progress={board({ fading: true, finished: true })}
        onFinished={onFinished}
      />,
    );

    fireEvent.animationEnd(screen.getByTestId("workspace-progress"));

    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});