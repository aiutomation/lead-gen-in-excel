# ━━━ SCRIPT OVERVIEW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PURPOSE: Combines LangGraph (workflow orchestration) with AutoGen
#   (Microsoft's multi-agent framework) to build a chatbot that remembers
#   past conversations AND can write + run Python code to answer questions.
#
# ┌──────────────────── DATA I/O FLOW ──────────────────────────────────┐
# │  [IN]  User message string  +  thread_id (memory key)               │
# │            ↓                                                         │
# │  workflow(messages, previous)                                        │
# │     add_messages() → merge previous + new into one ordered list     │
# │            ↓                                                         │
# │  call_autogen_agent(merged)            ← @task                       │
# │     convert_to_openai_messages() → plain dicts                       │
# │     user_proxy.initiate_chat(autogen_agent, ...)                    │
# │        ┌──────── AutoGen internal loop ────────┐                    │
# │        │ user_proxy ⇄ autogen_agent (GPT-4o)   │                    │
# │        │ runs code ⇄ writes code / plans       │                    │
# │        │ ends when a message ends in TERMINATE │                    │
# │        └────────────────────────────────────────┘                  │
# │     chat_history[-1]["content"] → final answer                      │
# │            ↓                                                         │
# │  entrypoint.final(value, save) → MemorySaver stores history         │
# │            ↓                                                         │
# │  [OUT] Streamed chunks → print(chunk)                               │
# └──────────────────────────────────────────────────────────────────────┘
#
# HOW IT WORKS:
#   1. Create two AutoGen agents: AssistantAgent (thinks) + UserProxyAgent (runs code)
#   2. Wrap them in a LangGraph @task so the graph can stream/await them
#   3. Attach a MemorySaver checkpointer to persist history per thread_id
#   4. Call workflow.stream() to run the graph and yield output live
#
# KEY DECISIONS:
#   - LangGraph vs plain AutoGen: AutoGen alone loses memory between runs;
#     LangGraph's checkpointer persists the thread across calls
#   - cache_seed=42: reproducible LLM outputs while developing
#   - use_docker=False: simpler for learning; set True in prod for sandboxing
#
# QUALITY: 8/10 — Clean integration, good learning scaffold
# IMPROVEMENTS: Swap MemorySaver → SqliteSaver for cross-restart persistence;
#   wrap initiate_chat() in try/except
# RED FLAGS: env-var API key is fine for dev; use a secrets manager in prod
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


# ── IMPORTS ────────────────────────────────────────────────────────────
# WHAT & WHY: Load every external library before any code runs — Python
#   needs explicit imports to know what "autogen" or "langgraph" mean.
# ───────────────────────────────────────────────────────────────────────

import getpass   # built-in: hidden text input (for secrets)
import os        # built-in: environment variables + filesystem
import autogen   # Microsoft AutoGen: AssistantAgent + UserProxyAgent

from langchain_core.messages import convert_to_openai_messages, BaseMessage
from langgraph.func import entrypoint, task
from langgraph.graph import add_messages
from langgraph.checkpoint.memory import MemorySaver


# ── API KEY SETUP ──────────────────────────────────────────────────────
# WHAT & WHY: Securely read the OpenAI key at runtime instead of hardcoding
#   it — so the file is safe to share and the key lives only in memory.
# IN:  var (name of an environment variable, e.g. "OPENAI_API_KEY")
# OUT: nothing returned; sets os.environ[var] as a side effect
# ───────────────────────────────────────────────────────────────────────

def _set_env(var: str):
    # SYNTAX: def name(arg: type) — type hint `: str` documents the expected type (not enforced)
    # IN    : var (a string variable name)
    # OUT   : — (defines the function; no return)
    # LOGIC : wrap the prompt-and-store steps so we can reuse them per key

    if not os.environ.get(var):
        # SYNTAX: dict.get(key) — returns the value or None if missing (no KeyError); `not None` is True
        # IN    : var (env-var name)
        # OUT   : bool — True when the variable is NOT already set
        # LOGIC : only prompt when the key is missing, so we don't overwrite an existing one

        os.environ[var] = getpass.getpass(f"{var}: ")
        # SYNTAX: f"{var}: " — f-string injects the variable's value into the text at runtime
        # IN    : the user's typed key (hidden) + the prompt label
        # OUT   : stores the key string into os.environ[var]
        # LOGIC : capture the secret without echoing it, make it globally readable

_set_env("OPENAI_API_KEY")
# SYNTAX: function call — runs the code we just defined
# IN    : the literal string "OPENAI_API_KEY"
# OUT   : — (side effect: env var is now set)
# LOGIC : ensure the key exists before any GPT-4o call below


# ── AUTOGEN AGENT CONFIGURATION ───────────────────────────────────────
# WHAT & WHY: Build the two agents that form the reasoning core. The
#   AssistantAgent plans and writes code; the UserProxyAgent runs it and
#   judges completion. Their back-and-forth is what enables multi-step
#   reasoning + code execution — neither agent alone does both.
# ───────────────────────────────────────────────────────────────────────

config_list = [{"model": "gpt-4o", "api_key": os.environ["OPENAI_API_KEY"]}]
# SYNTAX: os.environ["KEY"] — bracket access reads an env var (raises KeyError if absent)
# IN    : the OPENAI_API_KEY value from the environment
# OUT   : config_list (a list holding one config dict)
# LOGIC : tell AutoGen which model + credentials to use; list allows fallback models

llm_config = {
    # SYNTAX: { } — a dict literal; keys are strings, values are settings
    # IN    : the constants below + config_list
    # OUT   : llm_config (shared settings dict for both agents)
    # LOGIC : centralise LLM behaviour so both agents stay identical
    "timeout": 600,             # max seconds to wait for a GPT-4o reply
    "cache_seed": 42,           # fixed seed → same prompt returns same answer (debug-friendly)
    "config_list": config_list, # model + key from above
    "temperature": 0,           # 0 = deterministic/focused (best for math & code)
}

autogen_agent = autogen.AssistantAgent(
    # SYNTAX: Class(arg=value) — keyword arguments construct an object
    # IN    : name + llm_config
    # OUT   : autogen_agent (the "thinker" agent instance)
    # LOGIC : this agent reasons and writes code but does NOT execute it
    name="assistant",
    llm_config=llm_config,
)

user_proxy = autogen.UserProxyAgent(
    # SYNTAX: Class(arg=value) — same constructor pattern, more arguments
    # IN    : name, mode, limits, termination check, exec config, llm_config, system msg
    # OUT   : user_proxy (the "executor/judge" agent instance)
    # LOGIC : this agent runs the code the assistant writes and decides when done
    name="user_proxy",
    human_input_mode="NEVER",          # fully automated — never pause for a human
    max_consecutive_auto_reply=10,     # safety cap: stop after 10 turns (prevents infinite loops)

    is_termination_msg=lambda x: x.get("content", "").rstrip().endswith("TERMINATE"),
    # SYNTAX: lambda x: ... — anonymous one-line function; .rstrip() trims trailing whitespace;
    #         .endswith("TERMINATE") returns True if the text ends with that word
    # IN    : x (a message dict) → x.get("content", "") safely reads its text
    # OUT   : bool — True when the message signals the task is finished
    # LOGIC : AutoGen calls this after each message to know when to stop the loop

    code_execution_config={
        # SYNTAX: nested dict — settings for HOW generated code runs
        # IN    : work_dir + use_docker flags
        # OUT   : the exec config attached to user_proxy
        # LOGIC : control where code is written and whether it's sandboxed
        "work_dir": "web",      # folder where generated scripts are saved + run
        "use_docker": False,    # False = run on this machine; True = isolated Docker (safer)
    },

    llm_config=llm_config,
    system_message="Reply TERMINATE if the task has been solved at full satisfaction. "
                   "Otherwise, reply CONTINUE, or the reason why the task is not solved yet.",
    # SYNTAX: adjacent string literals on two lines auto-concatenate into one string
    # IN    : the instruction text
    # OUT   : the agent's "personality" / standing order
    # LOGIC : keep user_proxy focused on judging completion, not solving the task itself
)


# ── LANGGRAPH TASK: call_autogen_agent ────────────────────────────────
# WHAT & WHY: Wrap the whole AutoGen conversation as one LangGraph @task so
#   it becomes a streamable, awaitable step inside the graph.
# IN:  messages (full history: previous turns + current user message)
# OUT: {"role": "assistant", "content": "<final answer>"}
# ───────────────────────────────────────────────────────────────────────

@task
# SYNTAX: @decorator — wraps the function below, adding async/streaming behaviour
# LOGIC : turns a plain function into a LangGraph task the graph can control
def call_autogen_agent(messages: list[BaseMessage]):

    messages = convert_to_openai_messages(messages)
    # SYNTAX: function call — reassigns the result back onto `messages`
    # IN    : messages (list of LangChain BaseMessage objects)
    # OUT   : messages (now a list of plain dicts {"role","content"})
    # LOGIC : AutoGen understands OpenAI-style dicts, not LangChain objects — convert them

    response = user_proxy.initiate_chat(
        # SYNTAX: object.method(args) — starts the multi-agent chat
        # IN    : autogen_agent + the current message + carryover history
        # OUT   : response (a ChatResult holding the full conversation)
        # LOGIC : run the plan→code→execute→verify loop until TERMINATE
        autogen_agent,
        message=messages[-1],       # SYNTAX: [-1] negative index → last item (the new question)
        carryover=messages[:-1],    # SYNTAX: [:-1] slice → everything except the last (prior context)
    )

    content = response.chat_history[-1]["content"]
    # SYNTAX: chained access — [-1] last list item, then ["content"] dict key
    # IN    : response.chat_history (list of message dicts)
    # OUT   : content (the final answer string)
    # LOGIC : the last message holds the answer right before TERMINATE — extract it

    return {"role": "assistant", "content": content}
    # SYNTAX: return a dict literal
    # IN    : content
    # OUT   : an OpenAI-format message dict
    # LOGIC : hand the answer back so the graph can append it to history


# ── LANGGRAPH WORKFLOW: memory + entrypoint ───────────────────────────
# WHAT & WHY: Attach persistent memory and expose the agent loop as a
#   streamable graph. The checkpointer saves the full thread after every
#   call, so the same thread_id continues where it left off.
# ───────────────────────────────────────────────────────────────────────

checkpointer = MemorySaver()
# SYNTAX: Class() — construct an object with default settings
# IN    : — (no arguments)
# OUT   : checkpointer (an in-RAM history store)
# LOGIC : holds conversation state per thread_id (GOTCHA: lost on process restart)

@entrypoint(checkpointer=checkpointer)
# SYNTAX: @decorator(arg=value) — a decorator that itself takes arguments
# LOGIC : mark this as the graph's main entry; wire in memory so `previous` auto-loads
def workflow(messages: list[BaseMessage], previous: list[BaseMessage]):
    # IN    : messages (new this turn) + previous (loaded by the checkpointer)

    messages = add_messages(previous or [], messages)
    # SYNTAX: `previous or []` — short-circuit OR; uses [] when previous is None/falsy
    # IN    : previous history + new messages
    # OUT   : messages (one merged, de-duplicated list)
    # LOGIC : build the full conversation; handle the first turn where previous is None

    response = call_autogen_agent(messages).result()
    # SYNTAX: task(...).result() — run the @task and block until its value is ready
    # IN    : the merged messages list
    # OUT   : response (the assistant's answer dict)
    # LOGIC : delegate the actual reasoning to the AutoGen task

    return entrypoint.final(value=response, save=add_messages(messages, response))
    # SYNTAX: entrypoint.final(value=, save=) — return-now vs persist-for-later, in one call
    # IN    : response (to return) + messages+response (to save)
    # OUT   : the value streamed to the caller; saved state for next turn
    # LOGIC : reply now AND store the updated history so memory carries forward


# ── RUN: first message ─────────────────────────────────────────────────
# WHAT & WHY: Invoke the workflow with a question. .stream() yields output
#   chunks live instead of waiting for the whole agent loop to finish.
# ───────────────────────────────────────────────────────────────────────

config = {"configurable": {"thread_id": "2"}}
# SYNTAX: nested dict literal
# IN    : the thread_id value "2"
# OUT   : config (the run settings the checkpointer reads)
# LOGIC : identify which conversation thread to load/save (change it to start fresh)

for chunk in workflow.stream(
    # SYNTAX: for x in iterable — loops over each item .stream() yields
    # IN    : a list with one user-message dict + config
    # OUT   : chunk (one node's output per loop iteration)
    # LOGIC : run the graph and surface output as it's produced
    [{"role": "user", "content": "Which numbers between 1 and 50 are divisible by 7?"}],
    config,
):
    print(chunk)
    # SYNTAX: print() — built-in, writes to stdout
    # IN    : chunk (a dict like {"workflow": {"role": "assistant", "content": "..."}})
    # OUT   : text printed to the terminal
    # LOGIC : show each step's result to the user


# ── RUN: follow-up (memory demo) ──────────────────────────────────────
# WHAT & WHY: Send a second message on the SAME thread_id to prove memory.
#   "the last number" only resolves (to 49) if the agent recalls the prior turn.
# ───────────────────────────────────────────────────────────────────────

for chunk in workflow.stream(
    # IN    : a new user-message list + the SAME config (same thread_id)
    # OUT   : chunk per iteration
    # LOGIC : checkpointer auto-injects the previous history so "last number" = 49
    [{"role": "user", "content": "Multiply the last number by 3"}],
    config,
):
    print(chunk)
    # IN    : chunk  →  OUT: printed text  →  LOGIC: expected "49 * 3 = 147. TERMINATE"
