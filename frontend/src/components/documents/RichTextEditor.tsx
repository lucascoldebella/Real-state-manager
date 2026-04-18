'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  Heading2,
  Heading3,
  Palette,
  Undo,
  Redo,
} from 'lucide-react';
import styles from './RichTextEditor.module.css';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  readOnly?: boolean;
  minHeight?: number;
  showToolbar?: boolean;
  className?: string;
}

const PRESET_COLORS = [
  '#111827',
  '#1f2937',
  '#374151',
  '#6b7280',
  '#c9a84c',
  '#1a365d',
  '#2a4a7f',
  '#3b6cb5',
  '#10b981',
  '#ef4444',
  '#f59e0b',
  '#8b5cf6',
];

export const RichTextEditor: React.FC<RichTextEditorProps> = ({
  value,
  onChange,
  readOnly = false,
  minHeight = 400,
  showToolbar = true,
  className = '',
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const [showColor, setShowColor] = useState(false);
  const [lastHtml, setLastHtml] = useState('');

  useEffect(() => {
    if (!editorRef.current) return;
    if (value !== lastHtml && value !== editorRef.current.innerHTML) {
      editorRef.current.innerHTML = value || '';
      setLastHtml(value);
    }
  }, [value, lastHtml]);

  const exec = (command: string, arg?: string) => {
    if (readOnly) return;
    document.execCommand(command, false, arg);
    editorRef.current?.focus();
    emitChange();
  };

  const emitChange = () => {
    if (!editorRef.current) return;
    const html = editorRef.current.innerHTML;
    setLastHtml(html);
    onChange(html);
  };

  const handleInput = () => {
    emitChange();
  };

  const applyColor = (color: string) => {
    exec('foreColor', color);
    setShowColor(false);
  };

  return (
    <div className={`${styles.wrap} ${className}`}>
      {showToolbar && !readOnly && (
        <div className={styles.toolbar}>
          <button type="button" className={styles.btn} onClick={() => exec('undo')} title="Desfazer">
            <Undo size={15} />
          </button>
          <button type="button" className={styles.btn} onClick={() => exec('redo')} title="Refazer">
            <Redo size={15} />
          </button>
          <span className={styles.sep} />

          <button type="button" className={styles.btn} onClick={() => exec('bold')} title="Negrito">
            <Bold size={15} />
          </button>
          <button type="button" className={styles.btn} onClick={() => exec('italic')} title="Itálico">
            <Italic size={15} />
          </button>
          <button type="button" className={styles.btn} onClick={() => exec('underline')} title="Sublinhado">
            <Underline size={15} />
          </button>
          <span className={styles.sep} />

          <button type="button" className={styles.btn} onClick={() => exec('formatBlock', 'H2')} title="Título">
            <Heading2 size={15} />
          </button>
          <button type="button" className={styles.btn} onClick={() => exec('formatBlock', 'H3')} title="Subtítulo">
            <Heading3 size={15} />
          </button>
          <button type="button" className={styles.btn} onClick={() => exec('formatBlock', 'P')} title="Parágrafo">
            <span style={{ fontWeight: 600, fontSize: 12 }}>P</span>
          </button>
          <span className={styles.sep} />

          <button type="button" className={styles.btn} onClick={() => exec('insertUnorderedList')} title="Lista">
            <List size={15} />
          </button>
          <button type="button" className={styles.btn} onClick={() => exec('insertOrderedList')} title="Lista numerada">
            <ListOrdered size={15} />
          </button>
          <span className={styles.sep} />

          <button type="button" className={styles.btn} onClick={() => exec('justifyLeft')} title="Alinhar à esquerda">
            <AlignLeft size={15} />
          </button>
          <button type="button" className={styles.btn} onClick={() => exec('justifyCenter')} title="Centralizar">
            <AlignCenter size={15} />
          </button>
          <button type="button" className={styles.btn} onClick={() => exec('justifyRight')} title="Alinhar à direita">
            <AlignRight size={15} />
          </button>
          <button type="button" className={styles.btn} onClick={() => exec('justifyFull')} title="Justificar">
            <AlignJustify size={15} />
          </button>
          <span className={styles.sep} />

          <div className={styles.colorWrap}>
            <button type="button" className={styles.btn} onClick={() => setShowColor((v) => !v)} title="Cor do texto">
              <Palette size={15} />
            </button>
            {showColor && (
              <div className={styles.colorPopover}>
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={styles.colorSwatch}
                    style={{ background: c }}
                    onClick={() => applyColor(c)}
                    title={c}
                  />
                ))}
                <input
                  type="color"
                  className={styles.colorPicker}
                  onChange={(e) => applyColor(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      )}

      <div
        ref={editorRef}
        className={`${styles.editor} oc-document-body ${readOnly ? styles.readOnly : ''}`}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        onInput={handleInput}
        onBlur={handleInput}
        style={{ minHeight }}
      />
    </div>
  );
};
