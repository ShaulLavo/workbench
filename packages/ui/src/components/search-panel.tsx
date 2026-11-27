import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { resolveActivationFocus, type ActivationFocusDecision } from "@shaulavo/workbench-core";
import { FileTypeIcon } from "@shaulavo/workbench-icons/react";
import { cx } from "../utils/cx";
import { resolveListboxKeyAction } from "../utils/listbox";
import { FilterField, type FilterFieldHandle } from "./filter-field";
import { ToolPane } from "./tool-pane";
import { VirtualList } from "./virtual-list";

export interface SearchQueryOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

export interface SearchMatch {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
  readonly matchStart?: number;
  readonly matchLength?: number;
}

export interface SearchPanelProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly options?: SearchQueryOptions;
  readonly onOptionsChange?: (next: SearchQueryOptions) => void;
  readonly matches: readonly SearchMatch[];
  readonly pending?: boolean;
  readonly error?: string;
  readonly placeholder?: string;
  readonly onSelectMatch: (match: SearchMatch, focus: ActivationFocusDecision) => void;
  readonly className?: string;
}

function renderSnippet(match: SearchMatch) {
  const { preview, matchStart, matchLength } = match;
  if (matchStart === undefined || matchLength === undefined || matchLength <= 0) {
    return preview;
  }
  const start = Math.max(0, Math.min(preview.length, matchStart));
  const end = Math.max(start, Math.min(preview.length, start + matchLength));
  return (
    <>
      {preview.slice(0, start)}
      <mark className="wb-search-mark">{preview.slice(start, end)}</mark>
      {preview.slice(end)}
    </>
  );
}

/** Workspace search panel with regex/case/word toggles, file icons, keyboard handoff, and virtualized match rows. */
export function SearchPanel({
  query,
  onQueryChange,
  options,
  onOptionsChange,
  matches,
  pending = false,
  error,
  placeholder = "Search workspace…",
  onSelectMatch,
  className,
}: SearchPanelProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusRequest, setFocusRequest] = useState<{ readonly index: number; readonly seq: number } | null>(
    null,
  );
  const filterRef = useRef<FilterFieldHandle | null>(null);

  const currentOptions: SearchQueryOptions = options ?? {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  };

  function toggleOption(key: keyof SearchQueryOptions): void {
    onOptionsChange?.({ ...currentOptions, [key]: !currentOptions[key] });
  }

  function requestRowFocus(index: number): void {
    setActiveIndex(index);
    setFocusRequest((prev) => ({ index, seq: (prev?.seq ?? 0) + 1 }));
  }

  function handleArrowDownFromInput(): void {
    if (matches.length === 0) return;
    requestRowFocus(0);
  }

  function handleMatchClick(match: SearchMatch, index: number, event: MouseEvent<HTMLButtonElement>): void {
    setActiveIndex(index);
    const decision = resolveActivationFocus(event, "auto");
    onSelectMatch(match, decision);
  }

  function handleResultKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key === "Escape") {
      event.preventDefault();
      filterRef.current?.focus();
      return;
    }
    const action = resolveListboxKeyAction({
      key: event.key,
      count: matches.length,
      activeIndex: index,
      loop: false,
    });
    if (action.kind === "move") {
      event.preventDefault();
      requestRowFocus(action.index);
    }
  }

  const detail = query ? `${matches.length} ${matches.length === 1 ? "result" : "results"}` : undefined;
  const subheader = (
    <div className="wb-search-bar">
      <FilterField
        handleRef={filterRef}
        aria-label="Search query"
        placeholder={placeholder}
        value={query}
        onValueChange={onQueryChange}
        onArrowDown={handleArrowDownFromInput}
        trailing={
          onOptionsChange ? (
            <div className="wb-search-toggles" role="group" aria-label="Search options">
              <button
                type="button"
                className="wb-search-toggle"
                aria-label="Match case"
                aria-pressed={currentOptions.caseSensitive}
                data-active={currentOptions.caseSensitive ? "true" : "false"}
                onClick={() => toggleOption("caseSensitive")}
              >
                Aa
              </button>
              <button
                type="button"
                className="wb-search-toggle"
                aria-label="Match whole word"
                aria-pressed={currentOptions.wholeWord}
                data-active={currentOptions.wholeWord ? "true" : "false"}
                onClick={() => toggleOption("wholeWord")}
              >
                W
              </button>
              <button
                type="button"
                className="wb-search-toggle"
                aria-label="Use regular expression"
                aria-pressed={currentOptions.regex}
                data-active={currentOptions.regex ? "true" : "false"}
                onClick={() => toggleOption("regex")}
              >
                .*
              </button>
            </div>
          ) : null
        }
      />
    </div>
  );

  return (
    <ToolPane
      title="Search"
      detail={detail}
      subheader={subheader}
      scroll={false}
      state={{
        pending,
        error: Boolean(error),
        empty: !pending && !error && query.length > 0 && matches.length === 0,
      }}
      errorState={
        error ? (
          <div className="wb-pane-state wb-pane-state-error" role="alert">
            <span>{error}</span>
          </div>
        ) : undefined
      }
      emptyState={
        <div className="wb-pane-state">
          <span>No results for &ldquo;{query}&rdquo;</span>
        </div>
      }
      className={cx("wb-search-panel", className)}
    >
      {matches.length === 0 ? (
        <div className="wb-pane-state">
          <span>Type to search across files</span>
        </div>
      ) : (
        <VirtualList
          items={matches}
          getKey={(item) => item.id}
          activeIndex={activeIndex}
          estimateSize={(_item, _idx, rowHeight) => Math.max(rowHeight, 42)}
          initialRect={{ width: 320, height: 320 }}
          className="wb-search-results"
          renderRow={(match, index) => (
            <button
              ref={
                focusRequest && focusRequest.index === index
                  ? (node) => {
                      if (!node) return;
                      node.focus();
                      setFocusRequest((current) =>
                        current && current.seq === focusRequest.seq ? null : current,
                      );
                    }
                  : undefined
              }
              type="button"
              className="wb-search-row"
              tabIndex={index === activeIndex ? 0 : -1}
              data-active={index === activeIndex ? "true" : "false"}
              data-testid={`wb-search-match-${match.id}`}
              title={`${match.path}:${match.line}:${match.column}`}
              onKeyDown={(event) => handleResultKeyDown(event, index)}
              onClick={(event) => handleMatchClick(match, index, event)}
            >
              <span className="wb-search-row-header">
                <FileTypeIcon entry={{ name: match.path, type: "file" }} />
                <span className="wb-search-path">{match.path}</span>
                <span className="wb-search-loc">
                  {match.line}:{match.column}
                </span>
              </span>
              <span className="wb-search-preview">{renderSnippet(match)}</span>
            </button>
          )}
        />
      )}
    </ToolPane>
  );
}
