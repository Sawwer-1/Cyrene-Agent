# LawLLM-7B 三法定向训练管线

对本地法律模型 `lawllm`（复旦 DISC-LawLLM 的 Qwen2.5-7B-Instruct 重制版）做
**刑法 / 民法 / 劳动法**定向后训练（QLoRA），理论与实务并重，并注入
**中日比较法参照**（德国法因无可靠开源中译语料，仅散见于理论问答）。

## 流程总览

```
① 数据检索与分拣 ──► ② 训练集组装 ──► ③ QLoRA 训练 ──► ④ 合并 ──► ⑤ 量化 GGUF ──► ⑥ 重建 Ollama
```

## 数据来源（8,973 条，train 8,794 / val 179）

| 层 | 来源 | 构造方式 | 量 |
| --- | --- | --- | --- |
| 实务咨询 | DISC-Law-SFT（复旦，10.3 万条） | 按三法关键词打分分拣，法条引用/结构化/长度作质量信号精选 | 6,266 |
| 法条理论 | [ImCa0/just-laws](https://github.com/ImCa0/just-laws) 实文 | 零幻觉构造：条文背诵型（15%）+ 反向定位型（85%） | 1,604 |
| 依据跟随 | DISC-Law-SFT Triplet（带法条 reference） | reference 融入回答作【依据】段 | 900 |
| 比较法 | 教科书级通说（本仓库脚本内固化） | 中日对比深样本（×4 权重）+ 单侧衍生 | 203 |

三法分布：民法 3,445 / 劳动 2,850 / 刑法 2,499（劳动法语料稀缺故配比上调）。

比较法主题（25 个）：罪刑法定、刑事责任年龄、正当防卫、紧急避险、未遂、共犯、
故意杀人、盗窃、受贿（刑法）；成年年龄、物权变动、侵权一般条款、消灭时效、
合同解除、保证、离婚、不当得利（民法）；解雇权滥用、试用期、加班费、年休假、
合同形式、工伤劳灾、争议程序、劳务派遣（劳动法）。

## 训练配置

- 基座：`ShengbinYue/LawLLM-7B`（BF16，14.2GB，Qwen2.5-7B-Instruct 架构）
- 方法：QLoRA（NF4 + double quant，bf16 计算），r=32 / α=64 / dropout 0.05，
  挂 q/k/v/o/gate/up/down 全部投影
- seq 2048，batch 2 × grad_accum 8（有效 16），lr 1e-4 cosine，warmup 50 步
- 2 epochs ≈ 1,100 步，实测约 4 小时（RTX 5070 Ti 12GB，显存峰值 11.8GB）
- optimizer：paged_adamw_8bit

## 复现步骤

```bash
# 0) 环境：Python 3.12 + torch cu128（RTX 50 系必须 cu128）+ trl/datasets/bitsandbytes
#    本机复用了 MinerU 的 venv（D:\local ai\mineru\.venv）

# 1) 下载基座权重（hf-mirror）
#    https://hf-mirror.com/ShengbinYue/LawLLM-7B -> D:\local ai\models\LawLLM-7b-base

# 2) 下载语料
#    DISC-Law-SFT（hf-mirror.com/datasets/ShengbinYue/DISC-Law-SFT）
#    just-laws 法条（GitHub raw，刑法/民法典/劳动法/劳动合同法）

# 3) 组装数据（分拣 + 法条 QA + 比较法构造，见 build-dataset.mjs）
node build-dataset.mjs   # 产出 data/train.jsonl 与 data/val.jsonl

# 4) 干跑验证（50 步）
python train_lawllm.py --dry

# 5) 正式训练（约 4 小时；训练前 ollama stop lawllm 释放显存）
python train_lawllm.py

# 6) 合并 LoRA
python merge_lawllm.py   # -> output/lawllm-v2-merged (BF16)

# 7) 转 GGUF + 量化（llama.cpp b11849 工具链）
python llama.cpp/convert_hf_to_gguf.py output/lawllm-v2-merged --outfile lawllm-v2-f16.gguf --outtype f16
llama-quantize lawllm-v2-f16.gguf lawllm-v2.Q4_K_M.gguf Q4_K_M

# 8) 重建 Ollama（Modelfile 见本目录）
ollama create lawllm -f Modelfile.lawllm-v2
```

## 训练纪律

- 训练前后用固定问题集对照（法条引用准确性、三法各 2 问 + 比较法 1 问）。
- 法律数据的原则：**构造型样本必须零幻觉**（法条 QA 从实文生成，比较法仅写
  教科书级通说并固定免责声明）；DISC 数据沿用上游产出，未做逐条人工核验。
- 模型输出的法条引用仍不可全信（7B 级别的通病），Cyrene 的 legal 模式提示词
  保有"需核验"纪律。
