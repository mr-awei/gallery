import type { TutorialCategory } from './types';
import i18n from '../../i18n';

/** 设置逐项 + 数据出口 + 开发者集成 */
export function settingsTutorial(): TutorialCategory[] {
  return [
  {
    id: 'settings',
    title: i18n.t('ke692cb15'),
    sections: [
      {
        id: 'settings-general',
        title: i18n.t('k18f0e422'),
        summary: i18n.t('k1e224174'),
        keywords: [i18n.t('kaa05fd09'), i18n.t('kdccfb91d'), i18n.t('ka0315f0b'), i18n.t('kc33171a9'), i18n.t('ka78948fb')],
        body: i18n.t('k620b1d3d'),
      },
      {
        id: 'settings-crawl',
        title: i18n.t('k43a8c410'),
        summary: i18n.t('kaca0764f'),
        keywords: [i18n.t('k92411a01'), i18n.t('k394df2b7'), i18n.t('k0bb619c2'), i18n.t('ke5168a3f')],
        body: i18n.t('kcaab9f4b'),
      },
      {
        id: 'settings-ai',
        title: i18n.t('kd0ac5da4'),
        summary: i18n.t('kaef6acbd'),
        keywords: [i18n.t('k70ba6cfb'), 'API Key', i18n.t('k8000f187'), i18n.t('k37acc94c'), i18n.t('k224e2ccd')],
        body: i18n.t('k1000080b'),
      },
      {
        id: 'settings-enhance',
        title: i18n.t('k9865c7f7'),
        summary: i18n.t('k279d0543'),
        keywords: [i18n.t('k2abac8b6'), i18n.t('k8000f187'), i18n.t('kf034280d'), i18n.t('k0bd527e9')],
        body: i18n.t('k96840cd9'),
      },
      {
        id: 'settings-network',
        title: i18n.t('kd3ec5010'),
        summary: i18n.t('kc9044431'),
        keywords: [i18n.t('kfc954d25'), i18n.t('k7ddbe15c'), 'proxy', i18n.t('k5665b68b')],
        body: i18n.t('k1384e22d'),
      },
      {
        id: 'settings-extension',
        title: i18n.t('kcbad8114'),
        summary: i18n.t('kc449ca97'),
        keywords: [i18n.t('k9058622f'), i18n.t('k2f3f8e81'), i18n.t('kaaeb5463'), 'Chrome'],
        body: i18n.t('k33641b31'),
      },
      {
        id: 'settings-plugin',
        title: i18n.t('k88a016dc'),
        summary: i18n.t('kab785a31'),
        keywords: [i18n.t('k236b0cdd'), i18n.t('k3e5caf7e'), i18n.t('k463cba2d'), i18n.t('kba6e91fa')],
        body: i18n.t('k553213e7'),
      },
      {
        id: 'settings-lan',
        title: i18n.t('k2c4bb127'),
        summary: i18n.t('k432f55d5'),
        keywords: [i18n.t('k102f36ba'), i18n.t('k22b03c02'), i18n.t('k129bfcd1'), i18n.t('kd5a73b0c')],
        body: i18n.t('k8cc9536d'),
      },
      {
        id: 'settings-shortcut',
        title: i18n.t('kec0c6fc7'),
        summary: i18n.t('ka8f20068'),
        keywords: [i18n.t('kf7d29966'), i18n.t('kedf74d55'), i18n.t('kd8845c60'), i18n.t('k7468f3e5'), i18n.t('k93190be9')],
        body: i18n.t('k56bced9c'),
      },
      {
        id: 'settings-tasks',
        title: i18n.t('kc6e8a021'),
        summary: i18n.t('k46afdb79'),
        keywords: [i18n.t('k0e46d8d6'), i18n.t('kbd9fcf46'), i18n.t('kc827d8db'), i18n.t('kfea28a8c'), i18n.t('kd00b485b')],
        body: i18n.t('k2eb78d4e'),
      },
      {
        id: 'settings-update',
        title: i18n.t('kbafe3ed1'),
        summary: i18n.t('k278614c0'),
        keywords: [i18n.t('k32ac152b'), i18n.t('kfe2df04a'), i18n.t('k81d9f505'), i18n.t('k4ff13370')],
        body: i18n.t('k8bc38a82'),
      },
    ],
  },
  {
    id: 'data',
    title: i18n.t('k4deba3c8'),
    sections: [
      {
        id: 'sync-cloud',
        title: i18n.t('k0eaee627'),
        summary: i18n.t('k25b0f60f'),
        keywords: [i18n.t('kd99f6553'), i18n.t('k67bc37ad'), i18n.t('k83611abd'), i18n.t('k1d0274a5'), i18n.t('k93190be9')],
        body: i18n.t('k2ea2f68f'),
      },
      {
        id: 'data-export',
        title: i18n.t('k5b9f580c'),
        summary: i18n.t('kdc631318'),
        keywords: [i18n.t('k567a89e6'), 'CSV', 'JSON', i18n.t('k664b37da'), i18n.t('k55405ea6')],
        body: i18n.t('kf64aa46d'),
      },
      {
        id: 'workshop',
        title: i18n.t('k661cc070'),
        summary: i18n.t('k39f19240'),
        keywords: [i18n.t('k9c84d139'), i18n.t('k16eb2e5d'), 'tuku-pack', i18n.t('k8d9a071e'), i18n.t('k55405ea6')],
        body: i18n.t('kf0da5957'),
      },
      {
        id: 'recycle-settings',
        title: i18n.t('k86a2b694'),
        summary: i18n.t('k40a81eb8'),
        keywords: [i18n.t('k2896bd79'), i18n.t('k73279665'), i18n.t('k69de8d7f'), i18n.t('k288f0c40')],
        body: i18n.t('k6c4e7f03'),
      },
      {
        id: 'maintenance-tools',
        title: i18n.t('kaa120787'),
        summary: i18n.t('k32b17c71'),
        keywords: [i18n.t('k107baa8e'), i18n.t('kb7579706'), i18n.t('k7ba2fcc3'), i18n.t('k456d29ef'), i18n.t('k9bf26c4f')],
        body: i18n.t('k0767be50'),
      },
    ],
  },
  {
    id: 'dev',
    title: i18n.t('kd1f11619'),
    sections: [
      {
        id: 'api-tokens',
        title: i18n.t('k4abd7674'),
        summary: i18n.t('k561ed6e8'),
        keywords: ['API', i18n.t('k9f66731b'), 'token', 'scope', i18n.t('kba6e91fa')],
        body: i18n.t('k64a216d6'),
      },
      {
        id: 'api-audit',
        title: i18n.t('k2685efca'),
        summary: i18n.t('k9f44f0c3'),
        keywords: [i18n.t('k5c371147'), i18n.t('k771dc11a'), '120', 'rate limit'],
        body: i18n.t('k8510444c'),
      },
      {
        id: 'mcp-setup',
        title: i18n.t('k1162e4c3'),
        summary: i18n.t('kae0ebb47'),
        keywords: ['MCP', 'Claude', 'Cursor', i18n.t('k224e2ccd'), 'stdio'],
        body: i18n.t('k1624c8dd'),
      },
    ],
  },
  ];
}
