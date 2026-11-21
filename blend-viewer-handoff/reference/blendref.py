"""Reference .blend reader used to validate the handoff plan. Not production code."""
import struct, io, gzip, re, sys
def _load(path):
    d=open(path,'rb').read()
    if d[:4]==b'\x28\xb5\x2f\xfd':
        import zstandard; d=zstandard.ZstdDecompressor().stream_reader(io.BytesIO(d)).read()
    elif d[:2]==b'\x1f\x8b': d=gzip.decompress(d)
    return d
class Blend:
    def __init__(s,path):
        d=s.data=_load(path); assert d[:7]==b'BLENDER', d[:12]
        if d[7:9]==b'17':   # Blender 5.0+ header: BLENDER17-01v0500
            s.hdr=17; s.ptr=8; s.end='<'; s.version=int(d[13:17]); s.large=True
        else:               # legacy header: BLENDER-v402 / BLENDER_v279
            s.hdr=12; s.ptr=8 if d[7:8]==b'-' else 4; s.end='<' if d[8:9]==b'v' else '>'; s.version=int(d[9:12]); s.large=False
        s.bl=[]; pos=s.hdr; e=s.end
        while pos < len(d):
            code=d[pos:pos+4]
            if s.large: sdna,old,ln,nr=struct.unpack_from(e+'iQqq',d,pos+4); hs=32
            elif s.ptr==8: ln,old,sdna,nr=struct.unpack_from(e+'iQii',d,pos+4); hs=24
            else: ln,old,sdna,nr=struct.unpack_from(e+'iIii',d,pos+4); hs=20
            s.bl.append(dict(code=code.rstrip(b'\0'),sdna=sdna,old=old,len=ln,nr=nr,off=pos+hs)); pos+=hs+ln
            if code==b'ENDB': break
        s._dna(); s._groups()
    def _dna(s):
        b=[x for x in s.bl if x['code']==b'DNA1'][0]; off=b['off']; d=s.data; e=s.end
        al=lambda p: off+((p-off+3)&~3); p=off+4
        def strs(p):
            n,=struct.unpack_from(e+'i',d,p+4); p+=8; out=[]
            for _ in range(n):
                q=d.index(b'\0',p); out.append(d[p:q].decode()); p=q+1
            return out,al(p)
        s.names,p=strs(p); s.types,p=strs(p)
        p+=4; s.tlen=list(struct.unpack_from(e+'%dh'%len(s.types),d,p)); p=al(p+2*len(s.types))
        n,=struct.unpack_from(e+'i',d,p+4); p+=8; s.structs=[]
        for _ in range(n):
            t,nf=struct.unpack_from(e+'hh',d,p); p+=4; f=[]
            for _ in range(nf):
                ft,fn=struct.unpack_from(e+'hh',d,p); p+=4; f.append((s.types[ft],s.names[fn]))
            s.structs.append((s.types[t],f))
        s.sidx={st[0]:i for i,st in enumerate(s.structs)}; s._fc={}
    def _groups(s):
        # ID blocks (2-letter codes other than DATA/DNA1/ENDB/REND/TEST/GLOB) own the DATA blocks that follow them.
        s.ids={}; s.local=[]; cur=None
        for b in s.bl:
            if b['code'] in (b'DATA',):
                b['group']=cur; s.local[cur][b['old']]=b
            elif b['code'] in (b'DNA1',b'ENDB',b'REND',b'TEST',b'GLOB',b'USER'):
                cur=None; b['group']=None
            else:
                s.local.append({}); cur=len(s.local)-1; b['group']=cur; s.ids[b['old']]=b
    def resolve(s,ptr,group):
        if not ptr: return None
        if group is not None and ptr in s.local[group]: return s.local[group][ptr]
        return s.ids.get(ptr)
    def fields(s,sname):
        if sname in s._fc: return s._fc[sname]
        off=0; out={}
        for t,n in s.structs[s.sidx[sname]][1]:
            isptr='*' in n
            cnt=1
            for x in re.findall(r'\[(\d+)\]',n): cnt*=int(x)
            base=re.sub(r'\[.*','',n).replace('*','').replace('(','').replace(')','')
            sz=s.ptr if isptr else s.tlen[s.types.index(t)]
            out[base]=(t,isptr,cnt,off,sz); off+=sz*cnt
        s._fc[sname]=out; return out
    def has(s,sname,field): return sname in s.sidx and field in s.fields(sname)
    def get(s,sname,off,path):
        """path like 'id.name' ; returns python value"""
        parts=path.split('.')
        for i,p in enumerate(parts):
            t,isptr,cnt,o,sz=s.fields(sname)[p]; off+=o
            if i<len(parts)-1: sname=t
        e=s.end; d=s.data
        if isptr:
            fmt='Q' if s.ptr==8 else 'I'; v=struct.unpack_from(e+'%d%s'%(cnt,fmt),d,off); return v[0] if cnt==1 else list(v)
        if t=='char' and cnt>1: return d[off:off+cnt].split(b'\0')[0].decode('utf8','replace')
        if t in s.sidx: return off  # nested struct: return its offset
        fmt={'char':'b','uchar':'B','short':'h','ushort':'H','int':'i','uint':'I','float':'f','double':'d','int8_t':'b','uint8_t':'B','int16_t':'h','uint16_t':'H','int32_t':'i','uint32_t':'I','int64_t':'q','uint64_t':'Q','bool':'?'}[t]
        v=struct.unpack_from(e+'%d%s'%(cnt,fmt),d,off); return v[0] if cnt==1 else list(v)
    def sname(s,blk): return s.structs[blk['sdna']][0]
    def cstr(s,blk): return s.data[blk['off']:blk['off']+blk['len']].split(b'\0')[0].decode()
