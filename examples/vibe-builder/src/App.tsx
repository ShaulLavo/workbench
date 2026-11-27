import { useState } from "react";
import {
  DesktopSplitGrid,
  MobilePaneShell,
  StatusBar,
  TitleBar,
  ToolPane,
  useSubscribable,
  useViewportMode,
  WorkbenchShell,
} from "@shaulavo/workbench";
import { EditorWorkbench } from "@shaulavo/workbench/editor";
import { MarkdownComposer } from "@shaulavo/workbench/editor/composer";
import { PreviewPane } from "@shaulavo/workbench/preview";
import { TerminalPanel } from "@shaulavo/workbench/terminal";
import { FileTreeView } from "@shaulavo/workbench/tree";
import { createVibeBuilderBackend } from "./adapters";

export function VibeBuilderApp() {
  const [backend] = useState(() => createVibeBuilderBackend());
  const [mode, setMode] = useState<"light" | "dark">("dark");
  const [lastCommand, setLastCommand] = useState("none");
  const viewport = useViewportMode();
  const isPhone = viewport === "phone";
  const messages = useSubscribable(backend.messages);
  const mobilePane = useSubscribable(backend.layout.mobileActivePane);

  const explorerPane = (
    <ToolPane title="Files">
      <FileTreeView
        adapter={backend.fs}
        onOpenFile={(path, focus) => backend.groups.openDocument(path, { focus })}
      />
    </ToolPane>
  );

  const editorAndChatPane = (
    <div className="vibe-center-column">
      <div className="vibe-editor-slot">
        <EditorWorkbench documents={backend.documents} groups={backend.groups} />
      </div>
      <section className="vibe-agent-panel" aria-label="Agent composer">
        <div className="vibe-agent-timeline" data-testid="vibe-agent-timeline">
          {messages.map((msg) => (
            <div key={msg.id} className="vibe-agent-msg" data-role={msg.role}>
              <strong>{msg.role === "user" ? "You" : "Agent"}:</strong> {msg.text}
            </div>
          ))}
        </div>
        <MarkdownComposer
          ariaLabel="Prompt"
          placeholder="Ask the agent… @ for files, / for commands"
          mentionItems={backend.mentionItems}
          slashCommands={backend.slashCommands}
          onSelectCommand={(cmd) => setLastCommand(cmd.name)}
          onSubmit={({ text, mentions }) => backend.submitPrompt(text, mentions)}
        />
      </section>
    </div>
  );

  const previewPane = <PreviewPane adapter={backend.preview} />;
  const terminalPane = <TerminalPanel adapter={backend.terminal} />;

  return (
    <WorkbenchShell
      theme="fregat"
      colorScheme={mode}
      syncDocumentAttributes
      data-testid="vibe-ready"
      titleBar={
        <TitleBar
          leading={<strong>Vibe Builder</strong>}
          trailing={
            <button
              type="button"
              className="wb-button"
              data-testid="vibe-toggle-theme"
              onClick={() => setMode((m) => (m === "dark" ? "light" : "dark"))}
            >
              Theme: {mode}
            </button>
          }
        />
      }
      statusBar={
        <StatusBar
          leading="Consumer 3 starter kit"
          trailing={<span data-testid="vibe-command-status">command: {lastCommand}</span>}
        />
      }
    >
      {isPhone ? (
        <MobilePaneShell
          activePane={mobilePane}
          onSelectPane={(pane) => backend.layout.setMobileActivePane(pane)}
          panes={[
            { id: "explorer", label: "Files", content: explorerPane },
            { id: "editor", label: "Code & Chat", content: editorAndChatPane },
            { id: "preview", label: "Preview", content: previewPane },
            { id: "terminal", label: "Terminal", content: terminalPane },
          ]}
        />
      ) : (
        <DesktopSplitGrid
          layout={backend.layout}
          explorer={explorerPane}
          editor={editorAndChatPane}
          preview={previewPane}
          terminal={terminalPane}
        />
      )}
    </WorkbenchShell>
  );
}
