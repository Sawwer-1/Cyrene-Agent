# -*- coding: utf-8 -*-
"""LawLLM-7B 三法定向后训练（QLoRA）。
基座：ShengbinYue/LawLLM-7B（Qwen2.5-7B-Instruct 微调版，BF16）
数据：D:/local ai/train/data/train.jsonl（messages 格式 chat 样本）
输出：LoRA 适配器 -> D:/local ai/train/output/lawllm-v2-lora
用法：
  .venv/Scripts/python.exe train_lawllm.py            # 正式训练
  .venv/Scripts/python.exe train_lawllm.py --dry     # 干跑（50 步验证）
"""
import json
import os
import sys

import torch
from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

BASE = r"D:\local ai\models\LawLLM-7b-base"
DATA_DIR = r"D:\local ai\train\data"
OUT_DIR = r"D:\local ai\train\output\lawllm-v2-lora"
MAX_LEN = 1536
DRY_RUN = "--dry" in sys.argv

SYSTEM_FALLBACK = "你是 LawLLM，一个由复旦大学 DISC 实验室训练的中国法律助手。"


def main() -> None:
    tok = AutoTokenizer.from_pretrained(BASE)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        BASE,
        quantization_config=quant,
        torch_dtype=torch.bfloat16,
        attn_implementation="sdpa",
        device_map="cuda:0",
    )
    model.config.use_cache = False

    lora = LoraConfig(
        r=32,
        lora_alpha=64,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )

    ds = load_dataset("json", data_files={
        "train": os.path.join(DATA_DIR, "train.jsonl"),
        "validation": os.path.join(DATA_DIR, "val.jsonl"),
    })

    def format_sample(example):
        msgs = example["messages"]
        # 样本自带 system 时直接用；缺失则补
        if msgs[0]["role"] != "system":
            msgs = [{"role": "system", "content": SYSTEM_FALLBACK}] + msgs
        return {"text": tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)}

    ds = ds.map(format_sample, remove_columns=[c for c in ds["train"].column_names if c != "text"])

    cfg = SFTConfig(
        output_dir=OUT_DIR,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=16,
        per_device_eval_batch_size=2,
        eval_strategy="steps",
        eval_steps=100,
        num_train_epochs=2,
        learning_rate=1e-4,
        lr_scheduler_type="cosine",
        warmup_steps=50,
        logging_steps=10,
        save_strategy="steps",
        save_steps=300,
        save_total_limit=2,
        bf16=True,
        max_length=MAX_LEN,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        optim="paged_adamw_8bit",
        report_to=[],
        seed=42,
        packing=False,
        dataset_text_field="text",
    )
    if DRY_RUN:
        cfg.max_steps = 50
        cfg.eval_steps = 25
        cfg.save_strategy = "no"
        cfg.num_train_epochs = 1

    trainer = SFTTrainer(
        model=model,
        args=cfg,
        train_dataset=ds["train"],
        eval_dataset=ds["validation"],
        processing_class=tok,
        peft_config=lora,
    )
    trainer.train()
    trainer.save_model(OUT_DIR)
    tok.save_pretrained(OUT_DIR)
    print("DONE ->", OUT_DIR)


if __name__ == "__main__":
    main()
