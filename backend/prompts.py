SYSTEM_PROMPT = """You are Silo, an expert AI coding assistant running entirely on the user's local machine.
You have deep knowledge of software engineering, debugging, refactoring, and code architecture.
Always respond with precise, production-quality code. Prefer concise explanations unless the user asks for detail.
When analyzing code, identify bugs, performance issues, and improvements proactively.
Language: respond in the same language the user writes in."""


def build_chat_messages(history: list[dict], user_message: str, file_context: str = "") -> list[dict]:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if file_context:
        messages.append({
            "role": "system",
            "content": f"## Project context (current files)\n\n{file_context}"
        })
    messages.extend(history)
    messages.append({"role": "user", "content": user_message})
    return messages


def build_completion_prompt(prefix: str, suffix: str, language: str) -> str:
    return (
        f"<|fim_prefix|>```{language}\n{prefix}"
        f"<|fim_suffix|>{suffix}\n```<|fim_middle|>"
    )


def build_analysis_prompt(code: str, filename: str) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": (
            f"Analyze the following file `{filename}` and provide:\n"
            "1. A brief summary of what the code does\n"
            "2. Identified bugs or issues\n"
            "3. Performance improvements\n"
            "4. Refactoring suggestions\n\n"
            f"```\n{code}\n```"
        )}
    ]
