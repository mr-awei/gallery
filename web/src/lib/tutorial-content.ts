/**
 * 应用内教程内容库。
 *
 * 一个功能一条，正文按「是什么 → 怎么用 → 边界/坑」写，正文里的 `代码` 用反引号，
 * 强调用 **粗体**（渲染器只认这两种行内标记，不引 markdown 依赖）。
 * 关键词用来补同义词（壁纸 / 桌面 / 自动换），搜索只看这里的文字，不会去猜。
 */

import type { TutorialCategory, TutorialSection, TutorialShortcut } from './tutorial/types';
import { extraTutorial } from './tutorial/extra';
import i18n from '../i18n';

export type { TutorialCategory, TutorialSection, TutorialShortcut };

/** 首批（核心流程）内容；逐控件的小功能在 tutorial/extra-*.ts 里补齐 */
export function baseTutorial(): TutorialCategory[] {
  return [
  {
    id: 'start',
    title: i18n.t('k1fa42afe'),
    sections: [
      {
        id: 'first-run',
        title: i18n.t('k68e06e80'),
        summary: i18n.t('kb51d07ce'),
        keywords: [i18n.t('kd62c74b2'), i18n.t('ka3e3b883'), i18n.t('kf893f26a'), i18n.t('kc99f5cf1'), i18n.t('k2cb472ff'), i18n.t('k88d1e234')],
        body: i18n.t('kde4c2905'),
      },
      {
        id: 'ui-map',
        title: i18n.t('kb180b16c'),
        summary: i18n.t('k0ad8e984'),
        keywords: [i18n.t('k785abc97'), i18n.t('k5aefca55'), i18n.t('k63f4d73f'), i18n.t('k056f2d7d'), i18n.t('k230aaa6b'), i18n.t('k823ea45c')],
        body: i18n.t('ka32af0e5'),
      },
      {
        id: 'import-local',
        title: i18n.t('k50251f28'),
        summary: i18n.t('k1175824a'),
        keywords: [i18n.t('k8d9a071e'), i18n.t('k56525d62'), i18n.t('kaeaa7f29'), i18n.t('k36daebe0'), i18n.t('k1f4c1042')],
        body: i18n.t('k9c797938'),
      },
      {
        id: 'open-lightbox',
        title: i18n.t('ke0e5adae'),
        summary: i18n.t('k2c9bee38'),
        keywords: [i18n.t('k780c0435'), i18n.t('k7564e91e'), i18n.t('k645dbc55'), i18n.t('k369662b0'), i18n.t('kf7d29966')],
        body: i18n.t('kf40ff0c2'),
        shortcuts: [
          { keys: '← →', desc: i18n.t('k196b34c2') },
          { keys: '1 ~ 5', desc: i18n.t('k941f7d46') },
          { keys: 'F', desc: i18n.t('k51e36f9e') },
          { keys: 'Esc', desc: i18n.t('kd524403b') },
        ],
      },
    ],
  },
  {
    id: 'browse',
    title: i18n.t('kdfff8529'),
    sections: [
      {
        id: 'search-syntax',
        title: i18n.t('kfc308660'),
        summary: i18n.t('kba969ccd'),
        keywords: [i18n.t('ke5f71fc3'), i18n.t('kdc5d07a1'), i18n.t('kf2b0b493'), 'tag:', 'color:', 'rating:', 'folder:', 'kind:'],
        body: i18n.t('kef98a4ae'),
      },
      {
        id: 'filter-bar',
        title: i18n.t('ke8490846'),
        summary: i18n.t('k7950860a'),
        keywords: [i18n.t('kc2fe6253'), i18n.t('kbb8472c4'), i18n.t('k5f510057'), i18n.t('k6b36c6f7'), i18n.t('kc9cf5c3e'), i18n.t('k874a5816'), i18n.t('k26ca20b1')],
        body: i18n.t('kf1b2bd7a'),
      },
      {
        id: 'sort-view',
        title: i18n.t('kfd6e9704'),
        summary: i18n.t('k4cf1220a'),
        keywords: [i18n.t('kc360e994'), i18n.t('k096449bd'), i18n.t('kf290f3bb'), i18n.t('k16bf955c'), i18n.t('k3712972d'), i18n.t('k8818d483')],
        body: i18n.t('k14af02d5'),
      },
      {
        id: 'quick-preview',
        title: i18n.t('kb9c78eb4'),
        summary: i18n.t('k011efe02'),
        keywords: [i18n.t('kfcbc6a64'), i18n.t('kd1088dd1'), i18n.t('k645dbc55'), i18n.t('ke77eac7e')],
        body: i18n.t('k1a114c7a'),
        shortcuts: [{ keys: 'Space', desc: i18n.t('k1fba06e4') }],
      },
      {
        id: 'multi-select',
        title: i18n.t('k4d7e1d5c'),
        summary: i18n.t('kb11ceb20'),
        keywords: [i18n.t('k443f46c7'), i18n.t('ke099c261'), i18n.t('k83fba839'), i18n.t('k66eeacd9'), i18n.t('kad4ba3e8')],
        body: i18n.t('kd1ef457b'),
        shortcuts: [
          { keys: 'Ctrl+A', desc: i18n.t('k07ca2aa1') },
          { keys: 'Ctrl+Z', desc: i18n.t('k671bcf66') },
          { keys: 'Delete', desc: i18n.t('ke0c56298') },
        ],
      },
      {
        id: 'rate-color',
        title: i18n.t('keccf4ded'),
        summary: i18n.t('k0b84e01f'),
        keywords: [i18n.t('k108db12e'), i18n.t('k5f510057'), i18n.t('kae336cd0'), i18n.t('k74cc0b86'), i18n.t('k32bbccbc')],
        body: i18n.t('k56329391'),
      },
      {
        id: 'trash',
        title: i18n.t('kc54011cd'),
        summary: i18n.t('k4382a9c3'),
        keywords: [i18n.t('k2896bd79'), i18n.t('k2f4aaddd'), i18n.t('k69de8d7f'), i18n.t('kc7db6d4f'), i18n.t('k288f0c40')],
        body: i18n.t('kce67466a'),
      },
    ],
  },
  {
    id: 'organize',
    title: i18n.t('k7a00d68f'),
    sections: [
      {
        id: 'folders',
        title: i18n.t('k7af010e4'),
        summary: i18n.t('kb7fb8936'),
        keywords: [i18n.t('k1f4c1042'), i18n.t('k767fa455'), i18n.t('k5a650643'), i18n.t('k401e1e0f'), i18n.t('k68d982a1'), i18n.t('k510822bb')],
        body: i18n.t('k9b3ed580'),
      },
      {
        id: 'folder-order',
        title: i18n.t('k79add1ee'),
        summary: i18n.t('k23ae9000'),
        keywords: [i18n.t('kc360e994'), i18n.t('kc9534a96'), i18n.t('kbf47b493'), i18n.t('k78fc58fc')],
        body: i18n.t('k6ef2e215'),
      },
      {
        id: 'folder-appearance',
        title: i18n.t('k8ceae8ec'),
        summary: i18n.t('k717a3735'),
        keywords: [i18n.t('k5ef69f62'), 'emoji', i18n.t('k60d4e190'), i18n.t('k6b36c6f7'), i18n.t('kb11b2c40')],
        body: i18n.t('k360c3508'),
      },
      {
        id: 'folder-cover-lock',
        title: i18n.t('k620776fc'),
        summary: i18n.t('k4038ceb4'),
        keywords: [i18n.t('k41231061'), i18n.t('k29a91e99'), i18n.t('kc6b95eef'), i18n.t('k58c22144')],
        body: i18n.t('ka7729e35'),
      },
      {
        id: 'tags',
        title: i18n.t('kd0574ba4'),
        summary: i18n.t('k6b486aaa'),
        keywords: [i18n.t('k14d34236'), 'tag', i18n.t('kc8ce4b36'), i18n.t('kbd81577a'), i18n.t('k057a31b4'), i18n.t('k829abe5a')],
        body: i18n.t('k4e902358'),
      },
      {
        id: 'batch-create',
        title: i18n.t('k0b5ad8cc'),
        summary: i18n.t('kd5b7e511'),
        keywords: [i18n.t('ke099c261'), i18n.t('kd9ac9228'), i18n.t('k26bb8418'), i18n.t('k14d34236'), i18n.t('k1f4c1042')],
        body: i18n.t('kb4026d9a'),
      },
      {
        id: 'saved-filters',
        title: i18n.t('ka74e51bf'),
        summary: i18n.t('k9b079c27'),
        keywords: [i18n.t('k69e3d6a7'), i18n.t('k04ff0a57'), i18n.t('k4a3cd6b7'), i18n.t('kc0fd0276')],
        body: i18n.t('k7e594ff5'),
      },
    ],
  },
  {
    id: 'stack-note',
    title: i18n.t('k99501d89'),
    sections: [
      {
        id: 'stacks',
        title: i18n.t('k1d35a858'),
        summary: i18n.t('k3989b6ce'),
        keywords: [i18n.t('ka54cf19d'), 'stack', i18n.t('k28719dc5'), i18n.t('k86339e02'), i18n.t('k95b91885'), i18n.t('kbd81577a')],
        body: i18n.t('kb8586c4a'),
      },
      {
        id: 'notes',
        title: i18n.t('k63b90f03'),
        summary: i18n.t('kf56a57d5'),
        keywords: [i18n.t('k7051dc52'), i18n.t('k2432b575'), i18n.t('k30d47b8b'), i18n.t('k620bf820')],
        body: i18n.t('kd00e1ee9'),
      },
      {
        id: 'time-notes',
        title: i18n.t('k416be4a8'),
        summary: i18n.t('k90498b07'),
        keywords: [i18n.t('k76163c88'), i18n.t('k3d6283f6'), i18n.t('kd5bb34dc'), i18n.t('kd1a7cf6b'), i18n.t('k89b32034')],
        body: i18n.t('k4a14d808'),
      },
    ],
  },
  {
    id: 'tidy',
    title: i18n.t('kbead6622'),
    sections: [
      {
        id: 'pending',
        title: i18n.t('kbf8bc7e4'),
        summary: i18n.t('k76495d6a'),
        keywords: [i18n.t('ke723910f'), i18n.t('kecf7ebb5'), i18n.t('k3f9afcd7'), i18n.t('k7be04a8b'), i18n.t('ka4f65593')],
        body: i18n.t('k41608eef'),
      },
      {
        id: 'dup-md5',
        title: i18n.t('k37499f1b'),
        summary: i18n.t('k4a93bab0'),
        keywords: [i18n.t('kc2c0ef2a'), i18n.t('k33e3c0d2'), 'MD5', i18n.t('k6983ee9d'), i18n.t('k27bc6f5a')],
        body: i18n.t('kec989a11'),
      },
      {
        id: 'dup-phash',
        title: i18n.t('ke5dbfb19'),
        summary: i18n.t('k0dca2357'),
        keywords: [i18n.t('k8e80c978'), 'pHash', i18n.t('k9ec2fb47'), i18n.t('kc2c0ef2a'), i18n.t('kbc8791d6')],
        body: i18n.t('kdefbe591'),
      },
      {
        id: 'consistency',
        title: i18n.t('ka9e2d276'),
        summary: i18n.t('k2f8a3351'),
        keywords: [i18n.t('k20b044bc'), i18n.t('k4d61e000'), i18n.t('k2d6c0b76'), i18n.t('kcb39db57'), i18n.t('kd239370e')],
        body: i18n.t('k77bb3d4a'),
      },
      {
        id: 'orphan-thumbs',
        title: i18n.t('k01a8cf27'),
        summary: i18n.t('kf9297d93'),
        keywords: [i18n.t('k41aa92e2'), i18n.t('k0f088d8f'), i18n.t('ke47bb1cd'), i18n.t('ke80c310e'), 'dryRun'],
        body: i18n.t('k966e786d'),
      },
    ],
  },
  {
    id: 'edit',
    title: i18n.t('k5a97d1b1'),
    sections: [
      {
        id: 'crop',
        title: i18n.t('k40d9e627'),
        summary: i18n.t('k8733035e'),
        keywords: [i18n.t('k096cbe88'), i18n.t('k293cafbb'), i18n.t('k15007537'), i18n.t('ke0096ff3'), i18n.t('kc38d3f3b')],
        body: i18n.t('ke2ba9eae'),
      },
      {
        id: 'rotate',
        title: i18n.t('k03563efa'),
        summary: i18n.t('ka76e1371'),
        keywords: [i18n.t('k79b5a656'), i18n.t('k69ca6555'), i18n.t('k34772285'), i18n.t('ka465db53')],
        body: i18n.t('k65d6ad16'),
      },
      {
        id: 'adjust',
        title: i18n.t('k6a612dbe'),
        summary: i18n.t('k138417de'),
        keywords: [i18n.t('k9e368d03'), i18n.t('k131f6f6b'), i18n.t('kadc0d88f'), i18n.t('kbd05021d'), i18n.t('kc4985160'), i18n.t('ka4622c49')],
        body: i18n.t('kc30e6888'),
      },
      {
        id: 'inpaint',
        title: i18n.t('kebdf5cfa'),
        summary: i18n.t('k21cf49c9'),
        keywords: [i18n.t('kce03b0ad'), i18n.t('kf82661e8'), 'inpaint', i18n.t('k6056dbd0'), i18n.t('k4359e287')],
        body: i18n.t('k7d71f8d4'),
      },
      {
        id: 'annotate',
        title: i18n.t('k3965a15e'),
        summary: i18n.t('ka9ebb56b'),
        keywords: [i18n.t('k9f10db00'), i18n.t('kb5a15cf4'), i18n.t('kca746b1f'), i18n.t('k4e237ce4'), i18n.t('k50911250')],
        body: i18n.t('k956a06db'),
      },
      {
        id: 'watermark',
        title: i18n.t('keae1798d'),
        summary: i18n.t('kf8c9328f'),
        keywords: [i18n.t('kdc40df8d'), i18n.t('kcdd68c8f'), i18n.t('k961534b4'), i18n.t('k09307ce8'), i18n.t('k0b098228')],
        body: i18n.t('k97b2b08c'),
      },
      {
        id: 'enhance',
        title: i18n.t('k3eae58a3'),
        summary: i18n.t('ka5a73508'),
        keywords: [i18n.t('k9a5e2729'), i18n.t('k4f9b192c'), i18n.t('ka68f6a26'), i18n.t('k83ddead0'), i18n.t('k0e705f00')],
        body: i18n.t('ke1ef08ed'),
      },
      {
        id: 'video-trim',
        title: i18n.t('kaa76716f'),
        summary: i18n.t('k9c54aabc'),
        keywords: [i18n.t('k7fcf42ed'), i18n.t('k293cafbb'), 'GIF', 'WebM', i18n.t('kaff2639f'), i18n.t('ke47c4ea0')],
        body: i18n.t('k9a99b02c'),
      },
      {
        id: 'export',
        title: i18n.t('kf7f14ecc'),
        summary: i18n.t('kc10cfdc4'),
        keywords: [i18n.t('k55405ea6'), i18n.t('kf26ef914'), 'CSV', 'JSON', i18n.t('k28f69f99'), 'HTML'],
        body: i18n.t('k06e9e831'),
      },
    ],
  },
  {
    id: 'ingest',
    title: i18n.t('kf0a5041a'),
    sections: [
      {
        id: 'drop-paste',
        title: i18n.t('k173c2d7e'),
        summary: i18n.t('k64fe309d'),
        keywords: [i18n.t('k401e1e0f'), i18n.t('k536ff1ea'), i18n.t('k061b40d6'), i18n.t('keafbece1'), i18n.t('k369abff3')],
        body: i18n.t('k24f8bf18'),
      },
      {
        id: 'crawl',
        title: i18n.t('k5c575428'),
        summary: i18n.t('k067c80f0'),
        keywords: [i18n.t('ke8bc2616'), i18n.t('kfdd054bd'), i18n.t('k18a481ea'), i18n.t('ka3f6b859'), i18n.t('k26ca20b1')],
        body: i18n.t('k82a7a2e5'),
      },
      {
        id: 'extension',
        title: i18n.t('k7044f800'),
        summary: i18n.t('kf94e24db'),
        keywords: [i18n.t('k2dc90225'), i18n.t('k912302cb'), i18n.t('k483194d7'), i18n.t('k6e78d750'), 'Chrome'],
        body: i18n.t('k3e6fe01c'),
      },
      {
        id: 'screenshot',
        title: i18n.t('k6fad0e07'),
        summary: i18n.t('k0712bf47'),
        keywords: [i18n.t('k369abff3'), i18n.t('k21b8ea59'), i18n.t('k2dbc2d43'), i18n.t('k83fba839')],
        body: i18n.t('k8da40aec'),
      },
      {
        id: 'lan',
        title: i18n.t('kf0573db3'),
        summary: i18n.t('k34752671'),
        keywords: [i18n.t('k9f9d3632'), i18n.t('k5f2a9420'), i18n.t('kce80eb22'), i18n.t('k129bfcd1'), i18n.t('kd5a73b0c')],
        body: i18n.t('k2beafa48'),
      },
    ],
  },
  {
    id: 'wallpaper',
    title: i18n.t('kad7d1b4e'),
    sections: [
      {
        id: 'wallpaper',
        title: i18n.t('k1c3b326f'),
        summary: i18n.t('k378efc46'),
        keywords: [i18n.t('k8e92193d'), i18n.t('k2828b79c'), i18n.t('k3809ac48'), i18n.t('k72ebfe28'), i18n.t('k7043d02d')],
        body: i18n.t('k1d311e1d'),
      },
      {
        id: 'dynamic-wallpaper',
        title: i18n.t('k3694c068'),
        summary: i18n.t('kcf470422'),
        keywords: [i18n.t('k3bfbb815'), i18n.t('ke0817a03'), 'GLSL', i18n.t('kdeefe024'), i18n.t('k80c7f269'), i18n.t('kfaa3e374')],
        body: i18n.t('k3bbc51f6'),
      },
      {
        id: 'tray',
        title: i18n.t('k2a5c904a'),
        summary: i18n.t('k48434be9'),
        keywords: [i18n.t('k59baaf28'), i18n.t('k04bb50d4'), i18n.t('k2205b60e'), i18n.t('ka7d84685')],
        body: i18n.t('k09a69d59'),
      },
    ],
  },
  {
    id: 'ai',
    title: i18n.t('kddbc5488'),
    sections: [
      {
        id: 'semantic-search',
        title: i18n.t('k64e9998c'),
        summary: i18n.t('k3d43f805'),
        keywords: [i18n.t('k16d27cb3'), 'CLIP', i18n.t('kd325b64a'), i18n.t('k97005534'), i18n.t('kab094c3f')],
        body: i18n.t('k57d22af9'),
      },
      {
        id: 'ai-tag',
        title: i18n.t('k24de53a2'),
        summary: i18n.t('k184a6298'),
        keywords: ['AI', i18n.t('k87ae72cb'), i18n.t('k56750306'), i18n.t('k3bdd08ad'), i18n.t('kd570d995'), i18n.t('k108db12e')],
        body: i18n.t('kc5dd23f3'),
      },
      {
        id: 'knowledge',
        title: i18n.t('kc11caef7'),
        summary: i18n.t('k80e3c8f4'),
        keywords: [i18n.t('k7e433388'), i18n.t('kde2b2d43'), 'RAG', i18n.t('k0c268953')],
        body: i18n.t('ka1164e12'),
      },
      {
        id: 'ocr',
        title: i18n.t('kd1539daf'),
        summary: i18n.t('kfc2db90e'),
        keywords: ['OCR', i18n.t('k53cce5ba'), i18n.t('kdd0a177c'), i18n.t('k66dbcb8d')],
        body: i18n.t('k65b7b02d'),
      },
      {
        id: 'reverse-image',
        title: i18n.t('kc612b5c5'),
        summary: i18n.t('k400398cf'),
        keywords: [i18n.t('kc30d6c94'), i18n.t('k1f991660'), 'SauceNAO', 'Lens', 'TinEye'],
        body: i18n.t('kcb7e33b2'),
      },
      {
        id: 'plugins',
        title: i18n.t('k3b5c3bfb'),
        summary: i18n.t('kc14c75a0'),
        keywords: [i18n.t('k236b0cdd'), i18n.t('kba311d8a'), i18n.t('k4c65b7cd'), 'plugin', i18n.t('kee5040aa')],
        body: i18n.t('k83f4cfe5'),
      },
      {
        id: 'mcp-api',
        title: i18n.t('kc41a825f'),
        summary: i18n.t('ka6905dd5'),
        keywords: ['MCP', 'API', i18n.t('k54ea89b4'), i18n.t('k4c65b7cd'), 'Claude', 'Cursor'],
        body: i18n.t('kd9959e6a'),
      },
    ],
  },
  {
    id: 'data',
    title: i18n.t('k4deba3c8'),
    sections: [
      {
        id: 'libraries',
        title: i18n.t('k266fcaa5'),
        summary: i18n.t('k874b3b3a'),
        keywords: [i18n.t('kc99f5cf1'), i18n.t('k7d724220'), i18n.t('kbec7e4d6'), i18n.t('k408872c4')],
        body: i18n.t('k6cf8a074'),
      },
      {
        id: 'storage',
        title: i18n.t('k5dc06e5d'),
        summary: i18n.t('k504f931e'),
        keywords: [i18n.t('ka39cf1ca'), i18n.t('k4f35e80d'), 'tuku', i18n.t('k68051bf4'), i18n.t('k26defddb'), i18n.t('k8d59299a')],
        body: i18n.t('k166dd10b'),
      },
      {
        id: 'backup',
        title: i18n.t('k493e325d'),
        summary: i18n.t('k5eab753e'),
        keywords: [i18n.t('k664b37da'), i18n.t('kc7db6d4f'), i18n.t('k55405ea6'), i18n.t('k5af1ef08'), i18n.t('k0d830788')],
        body: i18n.t('k3c404824'),
      },
      {
        id: 'keymap',
        title: i18n.t('ka511f775'),
        summary: i18n.t('k016eb98f'),
        keywords: [i18n.t('kf7d29966'), i18n.t('kb29ac541'), i18n.t('k93e40c84'), 'Ctrl+K', i18n.t('kf1d4ff50')],
        body: i18n.t('k003168e4'),
        shortcuts: [
          { keys: 'Ctrl+K', desc: i18n.t('k93e40c84') },
          { keys: 'Ctrl+F', desc: i18n.t('kb0f61d34') },
          { keys: 'Alt+F', desc: i18n.t('k16bbb0b8') },
          { keys: 'F1', desc: i18n.t('kedfa445b') },
        ],
      },
      {
        id: 'update-logs',
        title: i18n.t('ka77440bc'),
        summary: i18n.t('k0c8e09c0'),
        keywords: [i18n.t('k32ac152b'), i18n.t('ke643c719'), i18n.t('k456d29ef'), i18n.t('k9bf26c4f'), i18n.t('k77283881'), i18n.t('kfe2df04a'), i18n.t('k81d9f505')],
        body: i18n.t('k4c4ced1c'),
      },
    ],
  },
  ];
}


/**
 * 合并顺序：核心流程在前，逐控件的小功能在后。
 * 同一分类 id 会在合并时合并 sections，方便 extra 文件按主题续写（不占地新建分类）。
 */
/**
 * 语料文案统一走 i18n，按当前界面语言取值；保留函数形态是为了让 extra 文件仍能按需拼装。
 * 调用方在挂载时取一次即可（切换语言会整页重载）。
 */
export function getTutorial(): TutorialCategory[] {
  const out: TutorialCategory[] = baseTutorial().map((c) => ({ ...c, sections: [...c.sections] }));
  for (const c of extraTutorial()) {
    const hit = out.find((x) => x.id === c.id);
    if (hit) hit.sections.push(...c.sections);
    else out.push(c);
  }
  return out;
}

export function getTutorialCategories(tutorial = getTutorial()) {
  return tutorial.map((c) => ({ id: c.id, title: c.title, count: c.sections.length }));
}

export function getTutorialTotal(tutorial = getTutorial()) {
  return tutorial.reduce((n, c) => n + c.sections.length, 0);
}

export function getTutorialSections(tutorial = getTutorial()) {
  return tutorial.flatMap((c) => c.sections.map((s) => ({ ...s, categoryId: c.id, categoryTitle: c.title })));
}
