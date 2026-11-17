import type { TutorialCategory } from './types';
import i18n from '../../i18n';

/** 整理进阶、采集/书签/清单、检索与智能、增强 */
export function workflowTutorial(): TutorialCategory[] {
  return [
  {
    id: 'tidy',
    title: i18n.t('kbead6622'),
    sections: [
      {
        id: 'tidy-overview',
        title: i18n.t('k96674ba0'),
        summary: i18n.t('k074f8ee3'),
        keywords: [i18n.t('k66922347'), i18n.t('k6bb5fc14'), i18n.t('ke0de1c9a'), i18n.t('kf515f8fb'), i18n.t('kc2c0ef2a')],
        body: i18n.t('kd3599610'),
      },
      {
        id: 'tidy-clip',
        title: i18n.t('k0bd7ff37'),
        summary: i18n.t('k557e7345'),
        keywords: [i18n.t('k1e2da177'), 'CLIP', i18n.t('k5a9039db'), i18n.t('k700d04f2')],
        body: i18n.t('k63b6481d'),
      },
      {
        id: 'tidy-same-name',
        title: i18n.t('kd9d170b8'),
        summary: i18n.t('k66c0da7b'),
        keywords: [i18n.t('ke675ccfa'), 'JPG', 'PNG', i18n.t('k26189bca')],
        body: i18n.t('k42dc28fc'),
      },
      {
        id: 'tidy-compare',
        title: i18n.t('k7a9d3c57'),
        summary: i18n.t('k7a5ec1f5'),
        keywords: [i18n.t('kf5deaa17'), i18n.t('k2d4bdcd5'), i18n.t('kfb27722a'), i18n.t('kac9ed536')],
        body: i18n.t('k6e59b527'),
      },
      {
        id: 'tidy-actions',
        title: i18n.t('kdd7bb691'),
        summary: i18n.t('k31b8811e'),
        keywords: [i18n.t('kf2563bf7'), i18n.t('k62f681af'), i18n.t('k92636e8c'), i18n.t('k4b9c3271'), i18n.t('k27de6262')],
        body: i18n.t('k6b38bb55'),
      },
      {
        id: 'tidy-maintenance',
        title: i18n.t('kc9bd2ab2'),
        summary: i18n.t('k79c05be1'),
        keywords: [i18n.t('k468aabaa'), i18n.t('kfbae87bc'), i18n.t('k45f9b3b4'), i18n.t('kf3678ad1'), i18n.t('ka1f3deec')],
        body: i18n.t('k1ec2b67e'),
      },
      {
        id: 'watch-folder',
        title: i18n.t('ke5ce9ace'),
        summary: i18n.t('kd4e01478'),
        keywords: [i18n.t('k9aff6241'), i18n.t('kdfb60c30'), i18n.t('k1f4c1042'), i18n.t('k9aa978f2')],
        body: i18n.t('k8d73eb0b'),
      },
    ],
  },
  {
    id: 'ingest',
    title: i18n.t('kf0a5041a'),
    sections: [
      {
        id: 'crawl-run',
        title: i18n.t('k5d17dd13'),
        summary: i18n.t('k13055b21'),
        keywords: [i18n.t('ke8bc2616'), i18n.t('ka3e3b883'), i18n.t('k095e938e'), i18n.t('kd8d7ca77'), i18n.t('kc7db6d4f')],
        body: i18n.t('k1d4448ed'),
      },
      {
        id: 'crawl-keywords',
        title: i18n.t('k1478f338'),
        summary: i18n.t('k944b6cb7'),
        keywords: [i18n.t('k9699a50e'), i18n.t('kad00783c'), i18n.t('ka6beb974'), i18n.t('kfb050d6c'), i18n.t('k8736cdfb')],
        body: i18n.t('kb3697e6a'),
      },
      {
        id: 'crawl-limits',
        title: i18n.t('k38678637'),
        summary: i18n.t('ke86b63de'),
        keywords: [i18n.t('kdab16cb8'), i18n.t('k065a9b80'), i18n.t('k11f1a688'), i18n.t('k972d5f82'), i18n.t('kdf9c9706')],
        body: i18n.t('ke86b6c3f'),
      },
      {
        id: 'crawl-logs',
        title: i18n.t('kd924db71'),
        summary: i18n.t('k9685971e'),
        keywords: [i18n.t('k456d29ef'), i18n.t('k6060a344'), i18n.t('k7030ff64'), i18n.t('k5665b68b')],
        body: i18n.t('k5e904589'),
      },
      {
        id: 'bookmarks',
        title: i18n.t('kf85593f3'),
        summary: i18n.t('k8abb24c2'),
        keywords: [i18n.t('k46779389'), i18n.t('k18a481ea'), i18n.t('k9f5e5b6d'), i18n.t('kb5dbc9ed'), i18n.t('k597224e6')],
        body: i18n.t('k16db7ebc'),
      },
      {
        id: 'bookmark-actions',
        title: i18n.t('kb7da7be2'),
        summary: i18n.t('k84fe9ffe'),
        keywords: [i18n.t('ka3d1ec98'), i18n.t('k3444ac8a'), i18n.t('k879058ce'), i18n.t('k095ea43d')],
        body: i18n.t('k567b4a4e'),
      },
      {
        id: 'playlists',
        title: i18n.t('kb51f96d9'),
        summary: i18n.t('kf01f71f5'),
        keywords: [i18n.t('k8d9a495b'), i18n.t('k3686b871'), i18n.t('kd239370e'), i18n.t('k3bdd08ad'), i18n.t('k508b37f1')],
        body: i18n.t('kfedba6b9'),
      },
      {
        id: 'playlist-actions',
        title: i18n.t('k361822ab'),
        summary: i18n.t('k3221f93d'),
        keywords: [i18n.t('k2b24d037'), i18n.t('kb033f97f'), i18n.t('kd8c27345'), i18n.t('ka5987d5c')],
        body: i18n.t('kc7779bd3'),
      },
    ],
  },
  {
    id: 'search',
    title: i18n.t('k8e971eb3'),
    sections: [
      {
        id: 'search-page',
        title: i18n.t('kc94788b0'),
        summary: i18n.t('kd1c4817f'),
        keywords: [i18n.t('kc5f36ba1'), i18n.t('k16d27cb3'), i18n.t('k6b36c6f7'), i18n.t('kc30d6c94'), 'Tab'],
        body: i18n.t('kac9066d8'),
      },
      {
        id: 'color-search',
        title: i18n.t('kcf3e8115'),
        summary: i18n.t('kaca4471a'),
        keywords: [i18n.t('kc89c32e1'), i18n.t('kd9061837'), i18n.t('ke705a4cd'), i18n.t('k3777c73e'), i18n.t('k8a7984d5')],
        body: i18n.t('k525b782d'),
      },
      {
        id: 'image-search',
        title: i18n.t('k02427b4b'),
        summary: i18n.t('k6e4fbd0e'),
        keywords: [i18n.t('kc30d6c94'), i18n.t('k3354fedd'), i18n.t('k16cfcd21'), i18n.t('kd5a73b0c')],
        body: i18n.t('k8967fe7a'),
      },
      {
        id: 'search-results',
        title: i18n.t('k6fa57847'),
        summary: i18n.t('kc88cf61b'),
        keywords: [i18n.t('kabb88af2'), i18n.t('kd0ce410c'), 'ZIP', i18n.t('ka2247c1d')],
        body: i18n.t('k0d664c91'),
      },
      {
        id: 'smart-page',
        title: i18n.t('kb83515ec'),
        summary: i18n.t('ke7fcbdc7'),
        keywords: [i18n.t('k04ff0a57'), i18n.t('k62fdcc59'), i18n.t('k645dbc55'), i18n.t('ka493312d')],
        body: i18n.t('k024778ea'),
      },
      {
        id: 'tag-alias',
        title: i18n.t('ka8759769'),
        summary: i18n.t('k095de989'),
        keywords: [i18n.t('keda5186c'), i18n.t('kb9306a95'), i18n.t('ke5f71fc3'), i18n.t('k14d34236')],
        body: i18n.t('k58d2dcff'),
      },
      {
        id: 'knowledge-rules',
        title: i18n.t('k27638f4c'),
        summary: i18n.t('k117dfa9c'),
        keywords: [i18n.t('k7e433388'), i18n.t('kb0fae043'), i18n.t('k4aac5591'), i18n.t('k4c20068a'), i18n.t('kbdb725bb')],
        body: i18n.t('kedd71d00'),
      },
      {
        id: 'ai-vision',
        title: i18n.t('kd7e6a876'),
        summary: i18n.t('k9438ccd2'),
        keywords: [i18n.t('kd7e6a876'), i18n.t('k37acc94c'), i18n.t('k4b0d02cd'), i18n.t('kfaa3c555')],
        body: i18n.t('k4beeab4c'),
      },
    ],
  },
  {
    // 与基础内容里的「AI 与自动化」合并，不新建同名分类
    id: 'ai',
    title: i18n.t('kddbc5488'),
    sections: [
      {
        id: 'enhance-page',
        title: i18n.t('k94ef7c49'),
        summary: i18n.t('kdb588c19'),
        keywords: [i18n.t('k8f053fef'), i18n.t('k8000f187'), i18n.t('k0bd527e9'), i18n.t('k8ab7234b')],
        body: i18n.t('k9ff8dbda'),
      },
      {
        id: 'ai-cutout',
        title: i18n.t('kddf25199'),
        summary: i18n.t('k60e001bf'),
        keywords: [i18n.t('k28ff2515'), i18n.t('k246ed331'), i18n.t('ka9cec4ef'), i18n.t('ka2a3346a')],
        body: i18n.t('k4d08bf21'),
      },
    ],
  },
  ];
}
