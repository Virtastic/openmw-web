# Symbolise a profile from profile-main-thread.mjs and print the hot spots. usage: report.py <openmw.js.symbols> <profile.json>
# The shipped openmw.wasm has no name section; the symbol map maps wasm-function[N] -> name (see docs/PERF-PROFILING.md).
import json,re,subprocess,collections,sys
symf,proff=sys.argv[1],sys.argv[2]
sym={}
for l in open(symf):
    i,_,n=l.rstrip('\n').partition(':'); sym[int(i)]=n
pr=json.load(open(proff)); nodes={n['id']:n for n in pr['nodes']}; parent={}
for n in pr['nodes']:
    for c in n.get('children',[]): parent[c]=n['id']
def nm(n):
    fn=n['callFrame']['functionName']; m=re.match(r'wasm-function\[(\d+)\]',fn)
    return sym.get(int(m.group(1)),fn) if m else (fn or '(anon)')
names={i:nm(n) for i,n in nodes.items()}
al=sorted(set(names.values()))
dem=dict(zip(al,subprocess.run(['c++filt'],input='\n'.join(al),capture_output=True,text=True).stdout.split('\n')))
self=collections.Counter()
for s,d in zip(pr['samples'],pr['timeDeltas']): self[s]+=d
incl=collections.Counter(); selfn=collections.Counter()
for nid,t in self.items():
    selfn[names[nid]]+=t; seen=set(); cur=nid
    while cur is not None:
        x=names[cur]
        if x not in seen: incl[x]+=t; seen.add(x)
        cur=parent.get(cur)
busy=sum(t for nid,t in self.items() if names[nid] not in('(idle)','(program)'))
frame=incl.get('OMW::Engine::frame(unsigned int, float)',0)
print('busy ms %.0f | Engine::frame ms %.0f'%(busy/1000,frame/1000))
def show(label,pat,table):
    for n,t in table.most_common():
        if re.search(pat,dem[n]): print('%-9s %6.0f ms %5.2f%% of frame  %s'%(label,t/1000,100*t/max(frame,1),dem[n][:80])); break
    else: print('%-9s (none)'%label)
show('incl','^MWSound::OpenALOutput::loadSound',incl)
show('incl','^MWSound::FFmpegDecoder::open',incl)
show('self','^mp3_read_probe',selfn)
show('self','^av_channel_layout_check',selfn)
show('incl','^avformat_find_stream_info',incl)
show('incl','^avformat_open_input',incl)
show('incl','^MWMechanics::ActiveSpells::update',incl)
show('incl','^osgViewer::ViewerBase::renderingTraversals',incl)
show('incl','^MWLua::LuaManager::synchronizedUpdate',incl)
