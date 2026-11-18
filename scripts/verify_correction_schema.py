"""Opt-in synthetic isolated PostgreSQL check; never reads app settings or live DB."""
import argparse
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import tempfile
from sqlalchemy import create_engine, text
from developer_migrate import Migration, apply_migrations, load_migrations

ROOT=Path(__file__).resolve().parents[1]


def run(bin_dir,output):
    output.mkdir(parents=True,exist_ok=True)
    cluster=Path(tempfile.mkdtemp(prefix='schema-',dir=output))
    bind=socket.socket();bind.bind(('127.0.0.1',0));port=bind.getsockname()[1];bind.close()
    def pg(name,*args):
        with (cluster/'control.log').open('a',encoding='utf-8') as log:
            result=subprocess.run([str(bin_dir/(name+'.exe')),*map(str,args)],stdout=log,stderr=log,text=True,timeout=60)
        if result.returncode:raise RuntimeError(name+' failed: '+'see isolated control.log')
    started=False
    engine=None
    checks=[]
    try:
        pg('initdb','-D',cluster/'data','-A','trust','-U','synthetic','--no-locale','--encoding=UTF8')
        pg('pg_ctl','-D',cluster/'data','-l',cluster/'postgres.log','-o',f'-h 127.0.0.1 -p {port}','-w','start')
        started=True
        engine=create_engine(f'postgresql+psycopg2://synthetic@127.0.0.1:{port}/postgres')
        schema="""CREATE TABLE exam_sessions(id uuid PRIMARY KEY, marker text);
CREATE TABLE interactions(id uuid PRIMARY KEY,session_id uuid REFERENCES exam_sessions(id));
CREATE TABLE grades(id integer PRIMARY KEY,score numeric);
INSERT INTO exam_sessions VALUES ('00000000-0000-0000-0000-000000000001','legacy-preserved');
INSERT INTO grades VALUES (1,7);"""
        migrations=[Migration('synthetic_fixture.sql',schema,hashlib.sha256(schema.encode()).hexdigest())]
        for name in ('019_question_audio_assets.sql','022_attempt_rubric_snapshot.sql','023_attempt_avatar_profile.sql','024_retained_avatar_segments.sql'):
            data=(ROOT/'database/migrations'/name).read_bytes()
            migrations.append(Migration(name,data.decode(),hashlib.sha256(data).hexdigest()))
        with engine.begin() as db:
            assert len(apply_migrations(db,migrations))==5
            checks.append('new additive schemas applied on isolated PostgreSQL')
        with engine.begin() as db:
            assert apply_migrations(db,migrations)==[]
            checks.append('repeat plan empty; complete filename/hash ledger verified')
            row=db.execute(text('SELECT * FROM exam_sessions')).mappings().one()
            assert row['marker']=='legacy-preserved' and row['assessment_rubric_snapshot'] is None and row['examiner_profile_snapshot'] is None
            assert db.execute(text('SELECT score FROM grades')).scalar()==7
            checks.append('historical grade and unknown legacy snapshots preserved')
            db.execute(text("INSERT INTO interactions VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001')"))
            for index in range(2):
                db.execute(text("""INSERT INTO exam_question_audio(id,session_id,interaction_id,request_id,input_hash,text_hash,content_hash,voice,speed,duration_seconds,byte_count,status,expires_at,media_type,profile_id,segment_index)
VALUES (CAST(:id AS uuid),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',CAST(:id AS uuid),:hash,:hash,:hash,'calm',1,1,32,'ready',now()+interval '1 day','video/mp4','prof-a',:index)"""),
                    {'id':f'00000000-0000-0000-0000-{index+10:012d}','hash':'0'*64,'index':index})
            assert db.execute(text('SELECT count(*) FROM exam_question_audio')).scalar()==2
            checks.append('ordered MP4 segments coexist without violating old WAV configuration uniqueness')
        with engine.connect().execution_options(isolation_level='AUTOCOMMIT') as db:
            db.exec_driver_sql('CREATE DATABASE synthetic_catalog')
        catalog_engine=create_engine(f'postgresql+psycopg2://synthetic@127.0.0.1:{port}/synthetic_catalog')
        try:
            catalog=load_migrations(ROOT/'database')
            with catalog_engine.begin() as db:
                applied=apply_migrations(db,catalog)
                assert len(applied)==len(catalog)
            with catalog_engine.begin() as db:
                assert apply_migrations(db,catalog)==[]
            checks.append(f'complete actual migration catalog applied and repeat plan empty ({len(catalog)} identities)')
        finally:
            catalog_engine.dispose()
        result={'checks':checks,'count':len(checks),'scope':'isolated disposable PostgreSQL; synthetic data only','cluster_stopped':False}
    finally:
        if engine:engine.dispose()
        if started or (cluster/'data/postmaster.pid').exists():pg('pg_ctl','-D',cluster/'data','-m','fast','-w','stop')
    result['cluster_stopped']=True
    (output/'schema-results.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--postgres-bin',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();run(args.postgres_bin.resolve(),args.output.resolve())
