import React from 'react';
import { isDesktop, pickFolder } from '../api';
import i18n from '../i18n';

/**
 * 保存方式（批量裁切台与批量调色台共用）：
 * - 覆盖原图：直接写回，原图消失（可撤销不了，提示写在 desc 里）
 * - 另存为副本：写成新文件，原图不动；目录留空则落在各自原图旁边
 *
 * 默认必须是「另存为副本」：编辑器的第一下点击不该是不可逆的写回。
 */
export interface SaveModeState {
  saveMode: 'overwrite' | 'copy';
  targetDir: string;
  addToLibrary: boolean;
}

export const SAVE_MODE_DEFAULT: SaveModeState = {
  saveMode: 'copy',
  targetDir: '',
  addToLibrary: true,
};

interface Props {
  value: SaveModeState;
  onChange: (patch: Partial<SaveModeState>) => void;
  disabled?: boolean;
  /** 副本数量（用于文案） */
  count: number;
  /** 覆盖原图时的额外提示，例如「裁切后原图不可恢复」 */
  overwriteHint?: string;
}

export default function SaveModeBlock({ value, onChange, disabled, count, overwriteHint }: Props) {
  const { saveMode, targetDir, addToLibrary } = value;
  return (
    <>
      <div className="lb-save-mode">
        <label className="lb-radio">
          <input
            type="radio"
            name="save-mode-shared"
            checked={saveMode === 'overwrite'}
            disabled={disabled}
            onChange={() => onChange({ saveMode: 'overwrite' })}
          />
          <span>{i18n.t('k7eeb7854')}</span>
        </label>
        <label className="lb-radio">
          <input
            type="radio"
            name="save-mode-shared"
            checked={saveMode === 'copy'}
            disabled={disabled}
            onChange={() => onChange({ saveMode: 'copy' })}
          />
          <span>{i18n.t('k297bb85d')}</span>
        </label>
      </div>
      {saveMode === 'copy' ? (
        <div className="lb-save-dir">
          <div className="lb-dir-row">
            <input
              className="input"
              value={targetDir}
              placeholder={i18n.t('k60cffa96')}
              readOnly={isDesktop}
              disabled={disabled}
              onChange={(e) => onChange({ targetDir: e.target.value })}
            />
            {isDesktop && (
              <button
                className="btn sm"
                disabled={disabled}
                onClick={async () => {
                  const d = await pickFolder();
                  if (d) onChange({ targetDir: d });
                }}
              >
                {i18n.t('k4f05519a')}
              </button>
            )}
          </div>
          <label className="lb-radio">
            <input
              type="checkbox"
              checked={addToLibrary}
              disabled={disabled}
              onChange={(e) => onChange({ addToLibrary: e.target.checked })}
            />
            <span>{i18n.t('k1db1db0d')}</span>
          </label>
          <p className="bulk-edit-desc">
            原图保持不变，{count} 份副本{targetDir ? i18n.t('k29f3272e') : i18n.t('k21911e5c')}（重名自动加序号）。
          </p>
        </div>
      ) : (
        overwriteHint && <p className="bulk-edit-desc">{overwriteHint}</p>
      )}
    </>
  );
}
