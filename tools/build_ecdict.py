# -*- coding: utf-8 -*-
"""ECDICT -> LingoFlow 离线词典分片构建脚本

数据来源：https://github.com/skywind3000/ECDICT （MIT）
产物：<extension>/dict/<a-z|_>.json + manifest.json

用法：
    python tools/build_ecdict.py [--top N] [--keep-en]

参数：
    --top N      当代语料库词频阈值（默认 150000，标准档 ~6MB / ~6 万词条）
    --keep-en    同时保留英文释义（definition 字段，体积约 +45%）

缓存目录（不入库）：~/.ecdict_cache
"""
import csv
import json
import os
import sys
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(os.path.expanduser("~"), ".ecdict_cache")
OUT = os.path.join(REPO, "dict")
CSV_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"
LEMMA_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/lemma.en.txt"


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print("cached:", dest)
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print("downloading:", url)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=180) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    print("saved:", dest, os.path.getsize(dest), "bytes")
    return dest


def shard_of(word):
    if not word:
        return "_"
    c = word[0].lower()
    return c if "a" <= c <= "z" else "_"


def to_int(v):
    try:
        return int(str(v or "0").strip() or 0)
    except Exception:
        return 0


def main():
    top = 150000
    keep_en = "--keep-en" in sys.argv
    for i, a in enumerate(sys.argv):
        if a == "--top" and i + 1 < len(sys.argv):
            top = int(sys.argv[i + 1])

    os.makedirs(OUT, exist_ok=True)
    csv_path = download(CSV_URL, os.path.join(CACHE, "ecdict.csv"))
    lemma_path = download(LEMMA_URL, os.path.join(CACHE, "lemma.en.txt"))

    shards = {}
    kept = set()
    infl = {}
    count = 0

    print("parsing csv ...")
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            w = (row.get("word") or "").strip()
            if not w:
                continue
            lw = w.lower()
            tr = (row.get("translation") or "").strip()
            ph = (row.get("phonetic") or "").strip()
            if not tr and not ph:
                continue

            frq = to_int(row.get("frq"))
            bnc = to_int(row.get("bnc"))
            col = to_int(row.get("collins"))
            ox_raw = str(row.get("oxford") or "0").strip()
            ox = 0 if ox_raw in ("", "0") else 1
            tag = (row.get("tag") or "").strip()

            keep = (frq > 0 and frq <= top) or (bnc > 0 and bnc <= top) or bool(tag) or ox == 1 or col > 0
            if not keep:
                continue

            entry = [ph, tr, (row.get("pos") or "").strip(), tag, col, ox, frq]
            if keep_en:
                entry.append((row.get("definition") or "").strip())
            shards.setdefault(shard_of(lw), {}).setdefault("words", {})[lw] = entry
            kept.add(lw)
            count += 1

            ex = (row.get("exchange") or "").strip()
            if ex:
                for item in ex.split("/"):
                    if ":" not in item:
                        continue
                    _t, form = item.split(":", 1)
                    form = form.strip().lower()
                    if form and form != lw:
                        infl[form] = lw

    print("kept words:", count)

    print("loading lemma ...")
    added = 0
    with open(lemma_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.replace("\t", " ").replace("->", " ").split()
            if len(parts) < 2:
                continue
            form = parts[0].strip().lower()
            base = parts[1].strip().lower()
            if not form or not base or form == base:
                continue
            if base in kept and form not in infl:
                infl[form] = base
                added += 1
    print("lemma inflections:", added, "total inflections:", len(infl))

    infl = {k: v for k, v in infl.items() if v in kept}
    print("usable inflections:", len(infl))

    print("writing shards ...")
    letters = [chr(c) for c in range(ord("a"), ord("z") + 1)] + ["_"]
    total = 0
    manifest = {
        "version": 1,
        "source": "ECDICT (skywind3000/ECDICT, MIT)",
        "buildTime": time.strftime("%Y-%m-%d"),
        "top": top,
        "keepEn": keep_en,
        "count": count,
        "shards": [],
    }
    for letter in letters:
        words = shards.get(letter, {}).get("words", {})
        shard_infl = {k: [v, shard_of(v)] for k, v in infl.items() if shard_of(k) == letter}
        if not words and not shard_infl:
            continue
        payload = {"words": words, "infl": shard_infl}
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        path = os.path.join(OUT, letter + ".json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(data)
        size = os.path.getsize(path)
        total += size
        manifest["shards"].append({"k": letter, "words": len(words), "infl": len(shard_infl), "bytes": size})

    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print("done. words:", count, "shards:", len(manifest["shards"]), "total:", round(total / 1048576.0, 2), "MB")


if __name__ == "__main__":
    main()
