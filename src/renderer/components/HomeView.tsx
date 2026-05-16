import { useEffect, useState } from 'react';
import { Document, Page } from 'react-pdf';

import iconUrl from '../assets/icon.png';
import { ipc } from '../lib/ipc.js';
import { useRecentThumb } from '../lib/useRecentThumb.js';
import { useTabsStore, type RecentDoc } from '../stores/tabs.js';

type ViewMode = 'list' | 'grid';
type HomeSection = 'recent' | 'starred' | 'computer';

interface HomeFolder {
  name: string;
  path: string;
}

export function HomeView(): JSX.Element {
  const recents = useTabsStore((s) => s.recents);
  const starred = useTabsStore((s) => s.starred);
  const openPdf = useTabsStore((s) => s.openPdf);
  const toggleStarred = useTabsStore((s) => s.toggleStarred);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [section, setSection] = useState<HomeSection>('recent');

  const handleOpen = async (defaultPath?: string) => {
    const filePath = await ipc.pdf.open(defaultPath);
    if (filePath) openPdf({ filePath });
  };

  const openRecent = (r: RecentDoc) =>
    openPdf({ filePath: r.filePath, title: r.title });

  const starredDocs = recents.filter((r) => starred.includes(r.filePath));
  const isStarred = (filePath: string) => starred.includes(filePath);

  return (
    <div className="home">
      <header className="home-welcome">
        <img src={iconUrl} alt="" className="home-welcome-icon" aria-hidden draggable={false} />
        <span className="home-welcome-text">Welcome to NodePDF</span>
        <button
          type="button"
          className="home-welcome-link"
          onClick={() => handleOpen()}
        >
          Open File
        </button>
      </header>
      <div className="home-body">
        <aside className="home-sidebar" aria-label="Navigation">
        <nav>
          <ul className="home-nav">
            <li>
              <SidebarItem
                icon={<IconClock />}
                label="Recent"
                active={section === 'recent'}
                onClick={() => setSection('recent')}
              />
            </li>
            <li>
              <SidebarItem
                icon={<IconStarOutline />}
                label="Starred"
                active={section === 'starred'}
                onClick={() => setSection('starred')}
              />
            </li>
            <li>
              <SidebarItem
                icon={<IconComputer />}
                label="Your computer"
                active={section === 'computer'}
                onClick={() => setSection('computer')}
              />
            </li>
          </ul>
        </nav>
      </aside>

      <main className="home-main">
        {section === 'recent' && (
          <RecentSection
            recents={recents}
            viewMode={viewMode}
            setViewMode={setViewMode}
            onOpen={() => handleOpen()}
            onOpenRecent={openRecent}
            isStarred={isStarred}
            onToggleStar={toggleStarred}
          />
        )}
        {section === 'starred' && (
          <StarredSection
            starred={starredDocs}
            viewMode={viewMode}
            setViewMode={setViewMode}
            onOpenRecent={openRecent}
            onToggleStar={toggleStarred}
            onGoToRecent={() => setSection('recent')}
          />
        )}
        {section === 'computer' && (
          <ComputerSection
            onPickInFolder={(folder) => handleOpen(folder)}
            onBrowse={() => handleOpen()}
          />
        )}
        </main>
      </div>
    </div>
  );
}

/* --- Sidebar item ------------------------------------------------------- */

interface SidebarItemProps {
  icon: JSX.Element;
  label: string;
  active: boolean;
  onClick(): void;
}

function SidebarItem({ icon, label, active, onClick }: SidebarItemProps): JSX.Element {
  return (
    <button
      type="button"
      className={`home-nav-item${active ? ' home-nav-active' : ''}`}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/* --- Recent section ----------------------------------------------------- */

interface RecentSectionProps {
  recents: RecentDoc[];
  viewMode: ViewMode;
  setViewMode(mode: ViewMode): void;
  onOpen(): void;
  onOpenRecent(recent: RecentDoc): void;
  isStarred(filePath: string): boolean;
  onToggleStar(filePath: string): void;
}

function RecentSection({
  recents,
  viewMode,
  setViewMode,
  onOpen,
  onOpenRecent,
  isStarred,
  onToggleStar,
}: RecentSectionProps): JSX.Element {
  return (
    <>
      <section className="home-card home-card-tools" aria-label="Recommended actions">
        <header className="home-card-header">
          <h2 className="home-card-title">Recommended actions</h2>
        </header>
        <div className="home-tools">
          <ToolItem
            icon={<IconOpen />}
            accent="open"
            title="Open a PDF"
            desc="Pick a PDF from your computer to start reading."
            onClick={onOpen}
          />
          <ToolItem
            icon={<IconStamp />}
            accent="stamp"
            title="Apply a stamp"
            desc="Open a PDF and apply any of your saved stamps."
            onClick={onOpen}
          />
          <ToolItem
            icon={<IconPrint />}
            accent="print"
            title="Print"
            desc="Open a PDF and send it straight to your printer."
            onClick={onOpen}
          />
        </div>
      </section>

      <RecentsBlock
        title="Recent"
        items={recents}
        viewMode={viewMode}
        setViewMode={setViewMode}
        onOpen={onOpenRecent}
        emptyHeading="No recent documents yet"
        emptyHint="Open a PDF to get started."
        isStarred={isStarred}
        onToggleStar={onToggleStar}
      />
    </>
  );
}

/* --- Starred section ---------------------------------------------------- */

interface StarredSectionProps {
  starred: RecentDoc[];
  viewMode: ViewMode;
  setViewMode(mode: ViewMode): void;
  onOpenRecent(recent: RecentDoc): void;
  onToggleStar(filePath: string): void;
  onGoToRecent(): void;
}

function StarredSection({
  starred,
  viewMode,
  setViewMode,
  onOpenRecent,
  onToggleStar,
  onGoToRecent,
}: StarredSectionProps): JSX.Element {
  if (starred.length === 0) {
    return (
      <section className="home-recents-section home-empty-section" aria-label="Starred">
        <header className="home-recents-header">
          <h2 className="home-card-title">Starred</h2>
          <ViewToggle mode={viewMode} setMode={setViewMode} />
        </header>
        <div className="home-empty">
          <div className="home-empty-icon" aria-hidden>
            <IconStarOutlineLarge />
          </div>
          <div className="home-empty-title">No starred files yet.</div>
          <div className="home-empty-desc">Your starred files will appear here.</div>
          <button type="button" className="home-empty-cta" onClick={onGoToRecent}>
            Star from Recent
          </button>
        </div>
      </section>
    );
  }
  return (
    <RecentsBlock
      title="Starred"
      items={starred}
      viewMode={viewMode}
      setViewMode={setViewMode}
      onOpen={onOpenRecent}
      emptyHeading="No starred files yet."
      emptyHint="Your starred files will appear here."
      isStarred={() => true}
      onToggleStar={onToggleStar}
    />
  );
}

/* --- Your computer section --------------------------------------------- */

interface ComputerSectionProps {
  /** Open the system "Open PDF" dialog rooted at the given folder. */
  onPickInFolder(folderPath: string): void;
  /** Open the dialog with no preset folder (OS default). */
  onBrowse(): void;
}

function ComputerSection({ onPickInFolder, onBrowse }: ComputerSectionProps): JSX.Element {
  const [folders, setFolders] = useState<HomeFolder[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void ipc.shell.homeFolders().then((list) => {
      if (!cancelled) setFolders(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="home-recents-section" aria-label="Your computer">
      <header className="home-recents-header">
        <h2 className="home-card-title">Your computer</h2>
      </header>
      {folders === null ? (
        <div className="home-recents-empty">Loading folders…</div>
      ) : folders.length === 0 ? (
        <div className="home-recents-empty">No standard folders detected on this machine.</div>
      ) : (
        <ul className="home-folders">
          {folders.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className="home-folder-item"
                onClick={() => onPickInFolder(f.path)}
                title={`Open a PDF from ${f.path}`}
              >
                <span className="home-folder-icon" aria-hidden>
                  <IconFolder />
                </span>
                <span className="home-folder-text">
                  <span className="home-folder-name">{f.name}</span>
                  <span className="home-folder-path">{f.path}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="home-browse-btn" onClick={onBrowse}>
        Browse
      </button>
    </section>
  );
}

/* --- Recents block (list/grid) shared between Recent and Starred -------- */

interface RecentsBlockProps {
  title: string;
  items: RecentDoc[];
  viewMode: ViewMode;
  setViewMode(mode: ViewMode): void;
  onOpen(recent: RecentDoc): void;
  emptyHeading: string;
  emptyHint: string;
  isStarred(filePath: string): boolean;
  onToggleStar(filePath: string): void;
}

function RecentsBlock({
  title,
  items,
  viewMode,
  setViewMode,
  onOpen,
  emptyHeading,
  emptyHint,
  isStarred,
  onToggleStar,
}: RecentsBlockProps): JSX.Element {
  return (
    <section className="home-recents-section" aria-label={title}>
      <header className="home-recents-header">
        <h2 className="home-card-title">{title}</h2>
        <ViewToggle mode={viewMode} setMode={setViewMode} />
      </header>
      {items.length === 0 ? (
        <div className="home-recents-empty">
          <div>{emptyHeading}</div>
          <div className="home-recents-empty-hint">{emptyHint}</div>
        </div>
      ) : viewMode === 'list' ? (
        <RecentsTable
          recents={items}
          onOpen={onOpen}
          isStarred={isStarred}
          onToggleStar={onToggleStar}
        />
      ) : (
        <RecentsGrid
          recents={items}
          onOpen={onOpen}
          isStarred={isStarred}
          onToggleStar={onToggleStar}
        />
      )}
    </section>
  );
}

interface ViewToggleProps {
  mode: ViewMode;
  setMode(mode: ViewMode): void;
}

function ViewToggle({ mode, setMode }: ViewToggleProps): JSX.Element {
  return (
    <div className="home-view-toggle" role="group" aria-label="View mode">
      <button
        type="button"
        className={`home-view-btn ${mode === 'list' ? 'is-active' : ''}`}
        onClick={() => setMode('list')}
        aria-label="List view"
        aria-pressed={mode === 'list'}
        title="List view"
      >
        <IconList />
      </button>
      <button
        type="button"
        className={`home-view-btn ${mode === 'grid' ? 'is-active' : ''}`}
        onClick={() => setMode('grid')}
        aria-label="Grid view"
        aria-pressed={mode === 'grid'}
        title="Grid view"
      >
        <IconGrid />
      </button>
    </div>
  );
}

/* --- Tool item ---------------------------------------------------------- */

interface ToolItemProps {
  icon: JSX.Element;
  /** Accent color hint applied to the icon background. */
  accent: 'open' | 'stamp' | 'print';
  title: string;
  desc: string;
  onClick(): void;
}

function ToolItem({ icon, accent, title, desc, onClick }: ToolItemProps): JSX.Element {
  return (
    <div className={`home-tool home-tool-${accent}`}>
      <div className="home-tool-icon">{icon}</div>
      <div className="home-tool-body">
        <div className="home-tool-title">{title}</div>
        <div className="home-tool-desc">{desc}</div>
        <button type="button" className="home-tool-cta" onClick={onClick}>
          Use now
        </button>
      </div>
    </div>
  );
}

/* --- Recents table ------------------------------------------------------ */

interface RecentsTableProps {
  recents: RecentDoc[];
  onOpen(recent: RecentDoc): void;
  isStarred(filePath: string): boolean;
  onToggleStar(filePath: string): void;
}

function RecentsTable({
  recents,
  onOpen,
  isStarred,
  onToggleStar,
}: RecentsTableProps): JSX.Element {
  return (
    <div className="home-recents-table-wrap">
      <table className="home-recents-table">
        <thead>
          <tr>
            <th className="home-recents-th-star" aria-label="Starred" />
            <th className="home-recents-th-name">Name</th>
            <th className="home-recents-th-opened">Opened</th>
          </tr>
        </thead>
        <tbody>
          {recents.map((r) => (
            <RecentsRow
              key={r.filePath}
              recent={r}
              starred={isStarred(r.filePath)}
              onOpen={() => onOpen(r)}
              onToggleStar={() => onToggleStar(r.filePath)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RecentsRowProps {
  recent: RecentDoc;
  starred: boolean;
  onOpen(): void;
  onToggleStar(): void;
}

function RecentsRow({
  recent,
  starred,
  onOpen,
  onToggleStar,
}: RecentsRowProps): JSX.Element {
  return (
    <tr
      className="home-recents-row"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      title={recent.filePath}
    >
      <td className="home-recents-cell-star">
        <button
          type="button"
          className={`home-star-btn${starred ? ' is-starred' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          aria-label={starred ? 'Unstar document' : 'Star document'}
          aria-pressed={starred}
          title={starred ? 'Unstar' : 'Star'}
        >
          {starred ? <IconStarFilled /> : <IconStarOutline />}
        </button>
      </td>
      <td>
        <div className="home-recents-name">
          <RowThumb filePath={recent.filePath} />
          <div className="home-recents-name-text">
            <div className="home-recents-name-title">{recent.title}</div>
            <div className="home-recents-name-format">PDF</div>
          </div>
        </div>
      </td>
      <td className="home-recents-opened">{formatOpened(recent.lastOpenedAt)}</td>
    </tr>
  );
}

function RowThumb({ filePath }: { filePath: string }): JSX.Element {
  const load = useRecentThumb(filePath);
  return (
    <div className="home-row-thumb" aria-hidden>
      {load.kind === 'thumb' && (
        <img src={load.url} alt="" draggable={false} className="home-row-thumb-img" />
      )}
      {load.kind === 'pdf' && (
        <Document file={{ data: load.data }} loading={null} error={null}>
          <Page
            pageNumber={1}
            width={36}
            renderTextLayer={false}
            renderAnnotationLayer={false}
          />
        </Document>
      )}
      {(load.kind === 'loading' || load.kind === 'error') && (
        <div className="home-row-thumb-placeholder" />
      )}
    </div>
  );
}

/* --- Recents grid ------------------------------------------------------- */

interface RecentsGridProps {
  recents: RecentDoc[];
  onOpen(recent: RecentDoc): void;
  isStarred(filePath: string): boolean;
  onToggleStar(filePath: string): void;
}

function RecentsGrid({
  recents,
  onOpen,
  isStarred,
  onToggleStar,
}: RecentsGridProps): JSX.Element {
  return (
    <div className="home-recents-grid">
      {recents.map((r) => (
        <GridItem
          key={r.filePath}
          recent={r}
          starred={isStarred(r.filePath)}
          onOpen={() => onOpen(r)}
          onToggleStar={() => onToggleStar(r.filePath)}
        />
      ))}
    </div>
  );
}

interface GridItemProps {
  recent: RecentDoc;
  starred: boolean;
  onOpen(): void;
  onToggleStar(): void;
}

function GridItem({ recent, starred, onOpen, onToggleStar }: GridItemProps): JSX.Element {
  const load = useRecentThumb(recent.filePath);
  return (
    <div className="home-grid-item" title={recent.filePath}>
      <button
        type="button"
        className={`home-grid-star${starred ? ' is-starred' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar();
        }}
        aria-label={starred ? 'Unstar document' : 'Star document'}
        aria-pressed={starred}
        title={starred ? 'Unstar' : 'Star'}
      >
        {starred ? <IconStarFilled /> : <IconStarOutline />}
      </button>
      <button
        type="button"
        className="home-grid-thumb-btn"
        onClick={onOpen}
        aria-label={`Open ${recent.title}`}
      >
        <div className="home-grid-thumb">
          {load.kind === 'thumb' && (
            <img
              src={load.url}
              alt=""
              draggable={false}
              className="home-grid-thumb-img"
            />
          )}
          {load.kind === 'pdf' && (
            <Document file={{ data: load.data }} loading={null} error={null}>
              <Page
                pageNumber={1}
                width={130}
                renderTextLayer={false}
                renderAnnotationLayer={false}
              />
            </Document>
          )}
          {(load.kind === 'loading' || load.kind === 'error') && (
            <div className="home-grid-thumb-placeholder" />
          )}
        </div>
        <div className="home-grid-name">{recent.title}</div>
      </button>
    </div>
  );
}

function formatOpened(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfThat = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfThat.getTime()) / (1000 * 60 * 60 * 24),
  );
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Yesterday, ${time}`;
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/* --- Inline icons ------------------------------------------------------- */

function IconClock(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.4V8l2.4 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconComputer(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 13.5h4M8 11v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconFolder(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7a1.5 1.5 0 0 1 1.5-1.5h4l1.6 1.7h9.4A1.5 1.5 0 0 1 21 8.7v8.8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconStarOutline(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.8l1.85 3.74 4.13.6-2.99 2.91.71 4.12L8 11.22l-3.7 1.95.71-4.12L2.02 6.14l4.13-.6z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function IconStarFilled(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M8 1.8l1.85 3.74 4.13.6-2.99 2.91.71 4.12L8 11.22l-3.7 1.95.71-4.12L2.02 6.14l4.13-.6z"
        fill="#f7c948"
        stroke="#f7c948"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconStarOutlineLarge(): JSX.Element {
  return (
    <svg width="72" height="72" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3l2.78 5.63 6.22.9-4.5 4.39 1.06 6.19L12 17.2l-5.56 2.91 1.06-6.19L3 9.53l6.22-.9z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function IconOpen(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 7a1.5 1.5 0 0 1 1.5-1.5h3.4l1.6 1.6h7.6A1.5 1.5 0 0 1 19.6 8.6v8.4a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 17z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconStamp(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 4h6l-.8 5.5a1.5 1.5 0 0 0 1.5 1.7H17v3H7v-3h1.3a1.5 1.5 0 0 0 1.5-1.7L9 4z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <rect
        x="5"
        y="16"
        width="14"
        height="2.4"
        rx="0.8"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function IconPrint(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 8.5V5h10v3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <rect
        x="4"
        y="8.5"
        width="16"
        height="8"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="7"
        y="13"
        width="10"
        height="6"
        rx="0.8"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function IconList(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M3 4.5h10M3 8h10M3 11.5h10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconGrid(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <rect x="3" y="3" width="4" height="4" rx="0.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <rect x="9" y="3" width="4" height="4" rx="0.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <rect x="3" y="9" width="4" height="4" rx="0.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <rect x="9" y="9" width="4" height="4" rx="0.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}
