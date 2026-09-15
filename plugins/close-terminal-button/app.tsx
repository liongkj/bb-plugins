import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type {
  BackgroundCommandSummary,
  rpcContract,
  TerminalSummary,
} from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";

function formatStatus(status: TerminalSummary["status"]): string {
  switch (status) {
    case "starting":
      return "starting";
    case "disconnected":
      return "disconnected";
    case "exited":
      return "exited";
    case "running":
      return "running";
  }
}

function TerminalRow({
  session,
  confirming,
  closing,
  onConfirm,
  onCancel,
  onRequestClose,
}: {
  session: TerminalSummary;
  confirming: boolean;
  closing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRequestClose: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <Icon name="Terminal" className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{session.title || "Terminal"}</p>
        <p className="truncate text-xs text-muted-foreground">
          {formatStatus(session.status)} · {session.initialCwd}
        </p>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="destructive"
            size="sm"
            disabled={closing}
            onClick={onConfirm}
          >
            {closing ? "Closing…" : "Confirm"}
          </Button>
          <Button variant="ghost" size="sm" disabled={closing} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={closing}
          onClick={onRequestClose}
          aria-label={`Close ${session.title || "terminal"}`}
        >
          Close
        </Button>
      )}
    </li>
  );
}

function BackgroundWorkNotice({
  commandCount,
  agentCount,
  confirming,
  stopping,
  onConfirm,
  onCancel,
  onRequestStop,
}: {
  commandCount: number;
  agentCount: number;
  confirming: boolean;
  stopping: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRequestStop: () => void;
}) {
  const commandLabel = commandCount === 1 ? "background command" : "background commands";
  const agentLabel = agentCount === 1 ? "background agent" : "background agents";

  return (
    <div className="grid gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3">
      <div>
        <p className="text-sm font-medium">Background work</p>
        <p className="text-xs text-muted-foreground">
          BB reports {commandCount} {commandLabel} and {agentCount} {agentLabel} in
          this thread. Stopping it ends all background commands and agents here;
          it does not close persistent terminal sessions.
        </p>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={stopping}
            onClick={onConfirm}
          >
            {stopping ? "Stopping…" : "Confirm stop"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={stopping}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="destructive"
          size="sm"
          className="w-fit"
          disabled={stopping}
          onClick={onRequestStop}
        >
          Stop background work
        </Button>
      )}
    </div>
  );
}

function CloseTerminalButton({
  threadId,
}: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<TerminalSummary[] | null>(null);
  const [backgroundCommands, setBackgroundCommands] = useState<
    BackgroundCommandSummary[] | null
  >(null);
  const [backgroundAgentCount, setBackgroundAgentCount] = useState(0);
  const [showButton, setShowButton] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [confirmingBackgroundStop, setConfirmingBackgroundStop] =
    useState(false);
  const [stoppingBackground, setStoppingBackground] = useState(false);
  const requestGeneration = useRef(0);

  const loadSessions = useCallback(
    async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
      const requestId = ++requestGeneration.current;
      setError(null);
      if (showLoading) {
        setSessions(null);
        setBackgroundCommands(null);
      }
      try {
        const result = await rpc.call("terminals_list", { threadId });
        if (requestId !== requestGeneration.current) {
          return;
        }
        setSessions(result.sessions);
        setBackgroundCommands(result.backgroundCommands);
        setBackgroundAgentCount(result.backgroundAgentCount);
        setShowButton(result.showButton);
      } catch (cause) {
        if (requestId !== requestGeneration.current) {
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [rpc, threadId],
  );

  useEffect(() => {
    setSessions(null);
    setBackgroundCommands(null);
    setBackgroundAgentCount(0);
    setShowButton(false);
    setError(null);
    setConfirmingId(null);
    setClosingId(null);
    setConfirmingBackgroundStop(false);
    setStoppingBackground(false);
  }, [threadId]);

  useEffect(() => {
    void loadSessions();
    const refreshTimer = window.setInterval(() => {
      void loadSessions();
    }, 5000);
    return () => {
      window.clearInterval(refreshTimer);
      requestGeneration.current += 1;
    };
  }, [loadSessions]);

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      setClosingId(terminalId);
      setError(null);
      try {
        const closed = await rpc.call("terminal_close", {
          threadId,
          terminalId,
        });
        setSessions((current) =>
          current?.filter((session) => session.id !== closed.id) ?? [],
        );
        void loadSessions();
        setConfirmingId(null);
        toast.success(`Closed ${closed.title || "terminal"}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setClosingId(null);
      }
    },
    [loadSessions, rpc, threadId],
  );

  const stopBackgroundWork = useCallback(async () => {
    setStoppingBackground(true);
    setError(null);
    try {
      await rpc.call("background_stop", { threadId });
      setConfirmingBackgroundStop(false);
      toast.success("Stopped background work");
      void loadSessions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStoppingBackground(false);
    }
  }, [loadSessions, rpc, threadId]);

  const openDialog = () => {
    setOpen(true);
    setConfirmingId(null);
    setConfirmingBackgroundStop(false);
    void loadSessions({ showLoading: true });
  };

  if (!showButton && !open) {
    return null;
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Close terminal"
        onClick={openDialog}
      >
        <Icon name="X" className="size-4" />
        <span className="sr-only">Close terminal</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setConfirmingId(null);
            setConfirmingBackgroundStop(false);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Close terminal</DialogTitle>
            <DialogDescription>
              Closing a terminal stops its shell and any process running in it.
              Stopping background work ends all background commands and agents
              in this thread.
            </DialogDescription>
          </DialogHeader>
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {sessions === null || backgroundCommands === null ? (
            <p className="text-sm text-muted-foreground">
              Loading terminal and background activity…
            </p>
          ) : (
            <div className="grid gap-4">
              {sessions.length > 0 ? (
                <div className="grid gap-2">
                  <p className="text-sm font-medium">Terminal sessions</p>
                  <ul className="grid gap-2">
                    {sessions.map((session) => (
                      <TerminalRow
                        key={session.id}
                        session={session}
                        confirming={confirmingId === session.id}
                        closing={closingId === session.id}
                        onRequestClose={() => setConfirmingId(session.id)}
                        onCancel={() => setConfirmingId(null)}
                        onConfirm={() => void closeTerminal(session.id)}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
              {backgroundCommands.length > 0 || backgroundAgentCount > 0 ? (
                <BackgroundWorkNotice
                  commandCount={backgroundCommands.length}
                  agentCount={backgroundAgentCount}
                  confirming={confirmingBackgroundStop}
                  stopping={stoppingBackground}
                  onRequestStop={() => setConfirmingBackgroundStop(true)}
                  onCancel={() => setConfirmingBackgroundStop(false)}
                  onConfirm={() => void stopBackgroundWork()}
                />
              ) : null}
              {sessions.length === 0 &&
              backgroundCommands.length === 0 &&
              backgroundAgentCount === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No active terminal sessions or background work belong to this
                  thread.
                </p>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "close-terminal",
    title: "Close terminal",
    component: CloseTerminalButton,
  });
});
