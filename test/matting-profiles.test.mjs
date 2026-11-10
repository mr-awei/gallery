import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config 在 import 时读环境变量，所以必须先设好再去动态 import
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuku-matting-'));
process.env.TUKU_USER_DATA = tmp;
delete process.env.TUKU_MATTING;

const { MATTING_PROFILES, mattingFiles, mattingStatus, activeMattingProfile, removeMatting } = await import(
  '../server/matting.js'
);
const { MODEL_CATALOG } = await import('../server/lib/model-catalog.js');

/**
 * 抠图档位是「一处定义、两处消费」：推理用 MATTING_PROFILES，下载中心用 MODEL_CATALOG。
 * 只加档位不加清单，用户就永远装不上；只加清单不加档位，点了下载会报「未知的模型档位」。
 */

test('每个抠图档位都有对应的下载中心条目，且体积/来源一致', () => {
  for (const p of MATTING_PROFILES) {
    const item = MODEL_CATALOG.find((m) => m.id === `matting:${p.id}`);
    assert.ok(item, `档位 ${p.id} 没进下载中心清单`);
    assert.equal(item.group, 'matting');
    assert.equal(item.sizeHint, p.sizeHint, `${p.id} 的预计体积两边写的不一样`);
    assert.ok(item.source.includes(p.repo), `${p.id} 的来源应指向 ${p.repo}`);
  }
  for (const m of MODEL_CATALOG.filter((x) => x.group === 'matting')) {
    assert.ok(
      MATTING_PROFILES.some((p) => `matting:${p.id}` === m.id),
      `清单里的 ${m.id} 没有对应档位，下载会直接报错`
    );
  }
});

test('落盘路径由档位定义推出（权重文件名跟仓库走，不写死 model.onnx）', () => {
  for (const p of MATTING_PROFILES) {
    const f = mattingFiles(p.id);
    assert.equal(f.modelFile, path.join(p.dir, path.basename(p.file)));
    // 老档位在 matting 根目录，新档位各自一层子目录：同一份定义只算一次
    assert.ok(f.modelFile.startsWith(path.join(tmp, 'data', 'ai', 'matting')));
  }
  assert.equal(mattingFiles('nope'), null);
});

test('自动选档：装了哪档质量高就用哪档（BEN2 > BiRefNet > U-2-Net）', async () => {
  // 1MB 以上才算装好，这里造真实体积的占位文件
  const fake = (id) => {
    const f = mattingFiles(id);
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(f.modelFile, Buffer.alloc(1024 * 1024 + 1));
  };
  fake('u2net');
  assert.equal(activeMattingProfile(), 'u2net');
  fake('birefnet-lite');
  assert.equal(activeMattingProfile(), 'birefnet-lite');
  fake('ben2');
  assert.equal(activeMattingProfile(), 'ben2', '装了旗舰档就该用旗舰档');

  // 删掉旗舰档要能回落到下一档，而不是继续报 ben2
  await removeMatting('ben2');
  assert.equal(fs.existsSync(mattingFiles('ben2').modelFile), false, '删除要真的把权重删掉');
  assert.equal(activeMattingProfile(), 'birefnet-lite');

  const st = mattingStatus();
  assert.equal(st.profile, 'birefnet-lite');
  assert.equal(st.profiles.length, MATTING_PROFILES.length);
  assert.equal(st.profiles.find((p) => p.id === 'ben2').installed, false);
});

test('TUKU_MATTING 可以强指定档位，写错则回落到自动选档', () => {
  process.env.TUKU_MATTING = 'u2net';
  assert.equal(activeMattingProfile(), 'u2net');
  process.env.TUKU_MATTING = 'not-a-profile';
  assert.equal(activeMattingProfile(), 'birefnet-lite');
  delete process.env.TUKU_MATTING;
});

test('未知档位不会静默装错文件', async () => {
  await assert.rejects(() => removeMatting('unknown'), /未知的模型档位/);
});
