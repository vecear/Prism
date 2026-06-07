// Prism — Lightweight ML utilities (clustering for trade journal & holdings)
// 純前端、無依賴。靈感來自 Substack 文章「AI 協助資產管理 — Clustering 入門 / Spectral Clustering」
// 暴露於 window.PrismML
(function () {
  'use strict';

  // ── 標準化（Z-score）——
  function zscoreMatrix(matrix) {
    if (!matrix.length) return { z: [], mean: [], std: [] };
    const cols = matrix[0].length;
    const mean = new Array(cols).fill(0);
    const std = new Array(cols).fill(0);
    for (const row of matrix) for (let j = 0; j < cols; j++) mean[j] += row[j];
    for (let j = 0; j < cols; j++) mean[j] /= matrix.length;
    for (const row of matrix) for (let j = 0; j < cols; j++) std[j] += (row[j] - mean[j]) ** 2;
    for (let j = 0; j < cols; j++) std[j] = Math.sqrt(std[j] / matrix.length) || 1;
    const z = matrix.map(r => r.map((v, j) => (v - mean[j]) / std[j]));
    return { z, mean, std };
  }

  function euclid(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
    return Math.sqrt(s);
  }

  // 隨機亂數產生器（seeded 以利重現）
  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // K-Means++ 初始化
  function kmeansPlusPlus(data, k, rng) {
    const centers = [data[Math.floor(rng() * data.length)].slice()];
    while (centers.length < k) {
      const dists = data.map(p => Math.min(...centers.map(c => euclid(p, c) ** 2)));
      const total = dists.reduce((a, b) => a + b, 0) || 1;
      let r = rng() * total, cum = 0, idx = 0;
      for (let i = 0; i < dists.length; i++) { cum += dists[i]; if (cum >= r) { idx = i; break; } }
      centers.push(data[idx].slice());
    }
    return centers;
  }

  // K-Means
  function kmeans(data, k, opts = {}) {
    const maxIter = opts.maxIter || 100;
    const seed = opts.seed != null ? opts.seed : 42;
    if (!data.length) return { labels: [], centers: [], inertia: 0 };
    if (data.length <= k) return { labels: data.map((_, i) => i), centers: data.map(r => r.slice()), inertia: 0 };
    const rng = mulberry32(seed);
    let centers = kmeansPlusPlus(data, k, rng);
    let labels = new Array(data.length).fill(0);
    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;
      for (let i = 0; i < data.length; i++) {
        let best = 0, bd = Infinity;
        for (let j = 0; j < k; j++) {
          const d = euclid(data[i], centers[j]);
          if (d < bd) { bd = d; best = j; }
        }
        if (labels[i] !== best) { labels[i] = best; changed = true; }
      }
      if (!changed && iter > 0) break;
      const sums = Array.from({ length: k }, () => new Array(data[0].length).fill(0));
      const counts = new Array(k).fill(0);
      for (let i = 0; i < data.length; i++) {
        const c = labels[i];
        counts[c]++;
        for (let j = 0; j < data[0].length; j++) sums[c][j] += data[i][j];
      }
      for (let c = 0; c < k; c++) {
        if (counts[c] > 0) for (let j = 0; j < data[0].length; j++) centers[c][j] = sums[c][j] / counts[c];
        else centers[c] = data[Math.floor(rng() * data.length)].slice();
      }
    }
    let inertia = 0;
    for (let i = 0; i < data.length; i++) inertia += euclid(data[i], centers[labels[i]]) ** 2;
    return { labels, centers, inertia };
  }

  // Silhouette score（用於選最佳 k）
  function silhouette(data, labels, k) {
    if (k < 2 || data.length <= k) return 0;
    const groups = Array.from({ length: k }, () => []);
    labels.forEach((l, i) => groups[l].push(i));
    let total = 0, n = 0;
    for (let i = 0; i < data.length; i++) {
      const own = groups[labels[i]];
      if (own.length < 2) continue;
      let a = 0;
      for (const j of own) if (j !== i) a += euclid(data[i], data[j]);
      a /= (own.length - 1);
      let b = Infinity;
      for (let c = 0; c < k; c++) {
        if (c === labels[i] || !groups[c].length) continue;
        let mean = 0;
        for (const j of groups[c]) mean += euclid(data[i], data[j]);
        mean /= groups[c].length;
        if (mean < b) b = mean;
      }
      total += (b - a) / Math.max(a, b);
      n++;
    }
    return n > 0 ? total / n : 0;
  }

  // 自動選 k（試 2..maxK，挑 silhouette 最高）
  function kmeansAuto(data, opts = {}) {
    const maxK = Math.min(opts.maxK || 5, Math.floor(data.length / 2));
    const minK = opts.minK || 2;
    if (data.length < minK * 2) return { ...kmeans(data, 1, opts), k: 1, score: 0 };
    let best = null;
    for (let k = minK; k <= maxK; k++) {
      const r = kmeans(data, k, opts);
      const score = silhouette(data, r.labels, k);
      if (!best || score > best.score) best = { ...r, k, score };
    }
    return best;
  }

  // Spectral-flavored clustering：建相似度矩陣 → 用前 k 個特徵向量做 K-Means
  // 簡化版 normalized spectral clustering（Ng-Jordan-Weiss 2002 風格）
  // 對於小資料（< 200 點）效能足夠，用於市場 regime 歷史辨識
  function spectralCluster(data, k, opts = {}) {
    const n = data.length;
    if (n <= k) return kmeans(data, k, opts);
    const sigma = opts.sigma || _autoSigma(data);
    // Affinity matrix
    const W = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = euclid(data[i], data[j]);
        const w = Math.exp(-(d * d) / (2 * sigma * sigma));
        W[i][j] = w; W[j][i] = w;
      }
    }
    // Degree & normalized Laplacian L = I - D^-1/2 W D^-1/2
    const D = W.map(row => row.reduce((s, v) => s + v, 0) || 1e-9);
    const Dinv = D.map(d => 1 / Math.sqrt(d));
    const L = Array.from({ length: n }, (_, i) => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        L[i][j] = (i === j ? 1 : 0) - Dinv[i] * W[i][j] * Dinv[j];
      }
    }
    // Power iteration to extract bottom-k eigenvectors（簡化：對 -L 做 deflated power method）
    // 對大 n 不適合，但對 n < 300 足夠
    const M = L.map(row => row.map(v => -v));   // 取最大 -L 即等同最小 L
    for (let i = 0; i < n; i++) M[i][i] += 2;   // shift 確保正定
    const seed = opts.seed != null ? opts.seed : 42;
    const rng = mulberry32(seed);               // seeded：確保 power iteration 初始向量可重現
    const vecs = _topKEigen(M, k, 80, rng);
    // 行標準化
    const rows = vecs.map(row => {
      const norm = Math.sqrt(row.reduce((s, v) => s + v * v, 0)) || 1;
      return row.map(v => v / norm);
    });
    return kmeans(rows, k, opts);
  }

  function _autoSigma(data) {
    // 用 median of pairwise distances（採樣 50 點）
    const sample = data.length > 50 ? data.slice(0, 50) : data;
    const ds = [];
    for (let i = 0; i < sample.length; i++)
      for (let j = i + 1; j < sample.length; j++)
        ds.push(euclid(sample[i], sample[j]));
    ds.sort((a, b) => a - b);
    return ds[Math.floor(ds.length / 2)] || 1;
  }

  function _matVec(M, v) {
    const n = M.length, r = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += M[i][j] * v[j];
      r[i] = s;
    }
    return r;
  }

  function _topKEigen(M, k, iters = 80, rng) {
    const rand = typeof rng === 'function' ? rng : Math.random;
    const n = M.length;
    const vecs = [];
    for (let p = 0; p < k; p++) {
      let v = new Array(n).fill(0).map(() => rand() - 0.5);
      for (let it = 0; it < iters; it++) {
        // Deflate against previous eigenvectors
        for (const u of vecs) {
          let dot = 0;
          for (let i = 0; i < n; i++) dot += u[i] * v[i];
          for (let i = 0; i < n; i++) v[i] -= dot * u[i];
        }
        v = _matVec(M, v);
        let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        v = v.map(x => x / norm);
      }
      // 符號正規化：令第一個非零分量為正，消除 power iteration 的任意符號歧義
      // 以穩定下游 kmeans 的輸入（特徵向量正負號不影響其作為特徵的有效性）
      let sign = 1;
      for (let i = 0; i < n; i++) {
        if (Math.abs(v[i]) > 1e-9) { sign = v[i] < 0 ? -1 : 1; break; }
      }
      if (sign < 0) v = v.map(x => -x);
      vecs.push(v);
    }
    // Transpose: rows = data points, cols = eigenvectors
    const result = Array.from({ length: n }, (_, i) => vecs.map(v => v[i]));
    return result;
  }

  // 計算每群統計：count, mean of each feature
  function clusterSummary(data, labels, k, featureNames) {
    const groups = Array.from({ length: k }, () => []);
    labels.forEach((l, i) => groups[l].push(data[i]));
    return groups.map((rows, ci) => {
      if (!rows.length) return { cluster: ci, count: 0, mean: [] };
      const cols = rows[0].length;
      const mean = new Array(cols).fill(0);
      for (const r of rows) for (let j = 0; j < cols; j++) mean[j] += r[j];
      for (let j = 0; j < cols; j++) mean[j] /= rows.length;
      return {
        cluster: ci,
        count: rows.length,
        mean,
        features: featureNames ? Object.fromEntries(featureNames.map((n, j) => [n, mean[j]])) : null,
      };
    });
  }

  // 把 cluster 重新編號讓 #0 永遠是樣本最多群（穩定 UI 顯示）
  function relabelBySize(labels, k) {
    const counts = new Array(k).fill(0);
    labels.forEach(l => counts[l]++);
    const order = counts.map((c, i) => [c, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    const map = new Array(k); order.forEach((old, ni) => { map[old] = ni; });
    return labels.map(l => map[l]);
  }

  window.PrismML = {
    zscoreMatrix, kmeans, kmeansAuto, spectralCluster,
    silhouette, clusterSummary, relabelBySize, euclid,
  };
})();
