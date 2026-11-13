"""Fixed native adapters; executor packets never supply commands or model overrides."""
from __future__ import annotations
import json
import os
from pathlib import Path
import shutil
import subprocess
from .core import WardenError

def safe_env():
    env=os.environ.copy()
    for key in list(env):
        if key.upper().startswith(('ANTHROPIC_','AWS_','AZURE_','GOOGLE_','OPENAI_')) or key in {'CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_USE_AZURE','CLAUDE_CODE_USE_API_KEY_HELPER'}:
            env.pop(key,None)
    return env

class NativeHandle:
    def __init__(self,binding:dict,run_root:Path):
        self.spec=binding['spec'];self.directory=run_root/binding['request']['id']
        self.directory.mkdir(parents=True,exist_ok=False)
        self.last=self.directory/'last-message.txt'
        prompt=binding['prompt']
        if self.spec['provider']=='codex':
            exe=shutil.which('codex')
            if not exe:raise WardenError('Codex CLI not found; no fallback')
            argv=[exe,'exec','--strict-config','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--color','never','--json','--model',self.spec['model'],'--config','model_reasoning_effort='+json.dumps(self.spec['effort']),'--config','approval_policy="never"','--config','web_search="disabled"','--config','project_doc_max_bytes=0','--config','agents.enabled=false','--cd',str(self.directory),'--output-last-message',str(self.last)]
            # Disable both direct tool surfaces and the code-mode executor. The latter
            # fails closed even if the host still advertises a deferred tool wrapper.
            for feature in ('code_mode_host','multi_agent','shell_tool','unified_exec','view_image','apps','plugins','remote_plugin','browser_use','browser_use_external','in_app_browser','computer_use','image_generation','skill_search','workspace_dependencies','sleep_tool','tool_suggest','memories'):
                argv.extend(['--disable',feature])
            argv.extend(['--enable','skip_host_skill_discovery','-'])
        else:
            exe=shutil.which('claude')
            if not exe:raise WardenError('Claude CLI not found; no fallback')
            mcp=self.directory/'empty-mcp.json';mcp.write_text('{"mcpServers":{}}',encoding='utf-8')
            settings=self.directory/'settings.json';settings.write_text('{"disableAllHooks":true,"enableAllProjectMcpServers":false,"permissions":{"allow":[],"deny":[]}}',encoding='utf-8')
            argv=[exe,'-p','--safe-mode','--restricted','--disable-slash-commands','--output-format','json','--tools','','--disallowed-tools','mcp__*','--strict-mcp-config','--mcp-config',str(mcp),'--setting-sources','','--settings',str(settings),'--no-session-persistence','--max-turns','1','--model','opus']
        (self.directory/'launch.json').write_text(json.dumps({'argv':argv,'task':binding['task'],'version':binding['version'],'requirements_sha256':binding['requirements_sha256'],'input_sha256':binding['input_sha256'],'configured_model':self.spec['model'],'provider':self.spec['provider']},ensure_ascii=False,indent=2),encoding='utf-8')
        (self.directory/'prompt.txt').write_text(prompt,encoding='utf-8')
        self.argv=argv;self.prompt=prompt
        self.process=subprocess.Popen(argv,cwd=self.directory,env=safe_env(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',errors='replace',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.pid=self.process.pid

    def result(self):
        try:out,err=self.process.communicate(self.prompt,timeout=240)
        except subprocess.TimeoutExpired:
            self.process.kill();out,err=self.process.communicate();raise WardenError('native model timeout; no retry or fallback')
        (self.directory/'stdout.txt').write_text(out,encoding='utf-8')
        (self.directory/'stderr.txt').write_text(err,encoding='utf-8')
        if len(out)>2_000_000 or len(err)>1_000_000:raise WardenError('native output exceeded limit')
        if self.process.returncode:
            # Provider errors are often returned as JSON on stdout with an empty
            # stderr (notably Claude usage-limit responses). Keep both streams
            # in the raised diagnostic so callers can classify the failure.
            diagnostic = ('native model exited ' + str(self.process.returncode)
                          + '; stdout: ' + out[-6000:] + '; stderr: ' + err[-1500:])
            raise WardenError(diagnostic)
        metadata={}
        if self.spec['provider']=='codex':
            text=self.last.read_text(encoding='utf-8') if self.last.exists() else ''
            metadata={'configured_model':self.spec['model'],'model_evidence':'explicit native CLI --model, backend telemetry not advertised'}
        else:
            data=json.loads(out);models=data.get('modelUsage',{})
            if data.get('is_error') or not models or any(not x.startswith('claude-opus-') for x in models):
                raise WardenError('Opus provider metadata missing, wrong model, or provider error')
            text=data.get('result','');metadata={'observed_models':list(models),'is_error':data.get('is_error')}
            self.last.write_text(text,encoding='utf-8')
        if not isinstance(text,str) or not text.strip():raise WardenError('native model returned empty text')
        return {'text':text,'last_message':str(self.last),'launch_record':str(self.directory/'launch.json'),'model_metadata':metadata,'pid':self.pid}

def launcher(run_root:Path):
    def launch(binding):
        if binding['spec']['provider'] == 'openai':
            from .openai_dispatch import OpenAIHandle
            return OpenAIHandle(binding, run_root)
        return NativeHandle(binding,run_root)
    return launch
