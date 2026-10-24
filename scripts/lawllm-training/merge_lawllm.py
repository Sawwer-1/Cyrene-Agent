# -*- coding: utf-8 -*-
"""合并 LoRA 到基座权重，输出完整 BF16 模型（供 llama.cpp 转 GGUF）。
用法：python merge_lawllm.py
输出：D:/local ai/train/output/lawllm-v2-merged
"""
import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE = r"D:\local ai\models\LawLLM-7b-base"
LORA = r"D:\local ai\train\output\lawllm-v2-lora"
OUT = r"D:\local ai\train\output\lawllm-v2-merged"

model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.bfloat16, device_map="cpu")
model = PeftModel.from_pretrained(model, LORA)
model = model.merge_and_unload()
model.save_pretrained(OUT, safe_serialization=True)
tok = AutoTokenizer.from_pretrained(BASE)
tok.save_pretrained(OUT)
print("MERGED ->", OUT)
