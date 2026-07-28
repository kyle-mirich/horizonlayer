import { useState } from 'react';

import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { RevisionRing } from '../components/RevisionRing';
import { useDashboard } from '../shell/DashboardContext';
import type { BlockType } from '../types';
import { AutoTextarea } from './page/AutoTextarea';
import { BLOCK_LABELS, PageBlockEditor } from './page/PageBlockEditor';
import { PageDetailsPanel } from './page/PageDetailsPanel';
import { usePageEditor } from './page/usePageEditor';
import './PageView.css';

function PageViewEditor({ pageId }: { pageId: string }) {
  const { navigate } = useDashboard();
  const editor = usePageEditor(pageId);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [showArchivedBlocks, setShowArchivedBlocks] = useState(false);
  const [archivePrompt, setArchivePrompt] = useState(false);

  if (editor.loading) {
    return (
      <main className="page-view page-view--loading" aria-busy="true" id="main-content">
        <div className="page-skeleton page-skeleton--eyebrow" />
        <div className="page-skeleton page-skeleton--title" />
        <div className="page-skeleton page-skeleton--line" />
        <div className="page-skeleton page-skeleton--line page-skeleton--short" />
      </main>
    );
  }

  if (!editor.page || editor.loadError) {
    return (
      <main className="page-view page-view--error" id="main-content">
        <div className="view-message">
          <span className="view-message__mark"><Icon name="warning" /></span>
          <p className="eyebrow">Page unavailable</p>
          <h1>We couldn’t open this page.</h1>
          <p>{editor.loadError ?? 'The page no longer exists.'}</p>
          <div className="view-message__actions">
            <button className="button button--primary" onClick={editor.retryLoad} type="button">
              <Icon name="refresh" /> Retry
            </button>
            <button className="button" onClick={() => navigate({ name: 'home' })} type="button">
              Back to workspace
            </button>
          </div>
        </div>
      </main>
    );
  }

  const page = editor.page;
  const archived = page.archived_at !== null;
  const visibleBlocks = showArchivedBlocks
    ? page.blocks
    : page.blocks.filter((block) => block.archived_at === null);
  const activeBlockCount = page.blocks.filter((block) => block.archived_at === null).length;
  const archivedBlockCount = page.blocks.length - activeBlockCount;

  return (
    <main className="page-view" id="main-content">
      {archived ? (
        <div className="archive-banner">
          <span>This page is archived and read-only.</span>
          <button
            className="text-button"
            disabled={editor.saveState === 'saving'}
            onClick={() => editor.setPageArchived(true)}
            type="button"
          >
            Restore page
          </button>
        </div>
      ) : null}

      <header className="page-view__header">
        <div className="page-view__breadcrumbs">
          <button className="breadcrumb-button" onClick={() => navigate({ name: 'home' })} type="button">
            {page.parent_page_id ? 'Nested page' : 'Page'}
          </button>
          <span aria-hidden="true">/</span>
          <span>rev {page.revision}</span>
        </div>
        <div className="page-view__tools">
          <RevisionRing state={editor.saveState} />
          {editor.saveState === 'conflict' || editor.saveState === 'error' ? (
            <button
              aria-label="Reload latest and discard local drafts"
              className="text-button"
              onClick={editor.reloadLatest}
              title="Discard local drafts and reload the latest saved page"
              type="button"
            >
              Reload latest
            </button>
          ) : null}
          <button
            aria-controls="page-details"
            aria-expanded={propertiesOpen}
            className="button button--quiet"
            onClick={() => setPropertiesOpen((open) => !open)}
            type="button"
          >
            Details
          </button>
          {!archived ? (
            <button
              aria-label="Archive page"
              className="icon-button"
              disabled={editor.saveState === 'saving'}
              onClick={() => setArchivePrompt(true)}
              type="button"
            >
              <Icon name="archive" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="page-sheet">
        <div className="page-sheet__meta">
          {page.tags.length ? page.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>) : (
            <span className="page-sheet__quiet">Untyped knowledge</span>
          )}
        </div>
        <AutoTextarea
          className="page-title-input"
          disabled={archived}
          label="Page title"
          onBlur={editor.saveTitle}
          onChange={editor.scheduleTitleSave}
          placeholder="Untitled page"
          value={editor.title}
        />

        {propertiesOpen ? (
          <PageDetailsPanel
            archived={archived}
            importance={editor.importanceDraft}
            onChangeImportance={editor.setImportanceDraft}
            onChangeTags={editor.setTagsDraft}
            onSave={() => editor.saveProperties(() => setPropertiesOpen(false))}
            tags={editor.tagsDraft}
          />
        ) : null}

        <section className="page-blocks" aria-label="Page content" id="page-content">
          {visibleBlocks.length ? visibleBlocks.map((block) => (
            <PageBlockEditor
              block={block}
              disabled={archived || editor.busyBlockIds.has(block.id)}
              key={block.id}
              onArchive={() => editor.mutateBlockArchive(block.id, false)}
              onChange={(content) => editor.scheduleBlockSave(block.id, content)}
              onRestore={() => editor.mutateBlockArchive(block.id, true)}
              onSave={() => editor.saveBlock(block.id)}
              onToggleTodo={(done) => editor.saveBlockMetadata(block.id, { ...block.metadata, done })}
            />
          )) : (
            <div className="page-blocks__empty">
              <span className="page-blocks__sprout" aria-hidden="true">✣</span>
              <p>{archived ? 'This archived page has no active blocks.' : 'This page is open ground.'}</p>
              <span>{archived ? 'Restore the page to add content.' : 'Add a block to begin shaping it.'}</span>
            </div>
          )}
        </section>

        {!archived ? (
          <div className="block-composer" aria-label="Add a block">
            <span><Icon name="plus" size={16} /> Add</span>
            {(Object.keys(BLOCK_LABELS) as BlockType[]).map((type) => (
              <button key={type} onClick={() => editor.appendBlock(type)} type="button">
                {BLOCK_LABELS[type]}
              </button>
            ))}
          </div>
        ) : null}

        {archivedBlockCount > 0 ? (
          <button
            aria-controls="page-content"
            aria-expanded={showArchivedBlocks}
            className="archived-blocks-toggle"
            onClick={() => setShowArchivedBlocks((shown) => !shown)}
            type="button"
          >
            {showArchivedBlocks ? 'Hide' : 'Show'} {archivedBlockCount} archived {archivedBlockCount === 1 ? 'block' : 'blocks'}
          </button>
        ) : null}
      </div>

      {archivePrompt ? (
        <Modal
          description="Agents will stop seeing it in normal reads and search. You can restore it from Archive."
          onClose={() => setArchivePrompt(false)}
          title="Archive this page?"
        >
          <div className="modal-actions">
            <button
              className="button"
              disabled={editor.saveState === 'saving'}
              onClick={() => setArchivePrompt(false)}
              type="button"
            >
              Keep page
            </button>
            <button
              className="button button--danger"
              disabled={editor.saveState === 'saving'}
              onClick={() => editor.setPageArchived(false, () => setArchivePrompt(false))}
              type="button"
            >
              Archive page
            </button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}

export function PageView({ pageId }: { pageId: string }) {
  return <PageViewEditor key={pageId} pageId={pageId} />;
}
