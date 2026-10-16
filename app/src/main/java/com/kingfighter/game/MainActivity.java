package com.kingfighter.game;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.*;
import android.view.*;
import android.content.Context;
import android.widget.FrameLayout;
import android.opengl.GLSurfaceView;
import android.opengl.GLU;
import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.Random;

public class MainActivity extends Activity {
    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setFlags(1024,1024);
        getWindow().getDecorView().setSystemUiVisibility(5894|1024|512|4096);
        FrameLayout root=new FrameLayout(this);
        GameSurface game=new GameSurface(this);
        root.addView(game);
        root.addView(new HUD(this,game),new FrameLayout.LayoutParams(-1,-1));
        setContentView(root);
    }
    static class GameSurface extends GLSurfaceView {
        final World world;
        GameSurface(Context c){super(c);setEGLContextClientVersion(1);world=new World();setRenderer(world);setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);}
        void act(String a){world.action(a);}
    }
    static class World implements GLSurfaceView.Renderer {
        volatile int hero=0, weapon=0, hp=100, ehp=100, score=0, combo=0;
        volatile boolean started=false, paused=false, blocking=false;
        volatile float playerX=-1.15f, enemyX=1.15f, playerZ=0, enemyZ=0;
        volatile long attackUntil=0,lastEnemy=0,lastCombo=0;
        volatile String message="TAP START TO FIGHT";
        final int[] colors={0xff18d9ff,0xffbd67ff,0xffffa33a,0xff65f28b};
        final String[] names={"VOLT","SHADOW","TITAN","PHANTOM"};
        final String[] weapons={"BARE HANDS","ENERGY BLADE","HAMMER","DUAL DAGGERS"};
        final Random random=new Random();
        long startAt=System.currentTimeMillis();
        public void onSurfaceCreated(GL10 gl,EGLConfig config){
            gl.glClearColor(0.015f,0.025f,0.07f,1);gl.glEnable(GL10.GL_DEPTH_TEST);gl.glEnable(GL10.GL_CULL_FACE);gl.glShadeModel(GL10.GL_SMOOTH);
            gl.glEnable(GL10.GL_LIGHTING);gl.glEnable(GL10.GL_LIGHT0);
            float[] pos={-3,5,6,1};float[] amb={0.35f,0.35f,0.48f,1};float[] dif={0.85f,0.9f,1,1};
            gl.glLightfv(GL10.GL_LIGHT0,GL10.GL_POSITION,pos,0);gl.glLightfv(GL10.GL_LIGHT0,GL10.GL_AMBIENT,amb,0);gl.glLightfv(GL10.GL_LIGHT0,GL10.GL_DIFFUSE,dif,0);
        }
        public void onSurfaceChanged(GL10 gl,int w,int h){gl.glViewport(0,0,w,h);gl.glMatrixMode(GL10.GL_PROJECTION);gl.glLoadIdentity();GLU.gluPerspective(gl,52f,(float)w/Math.max(1,h),0.1f,80f);gl.glMatrixMode(GL10.GL_MODELVIEW);}
        public void onDrawFrame(GL10 gl){
            gl.glClear(GL10.GL_COLOR_BUFFER_BIT|GL10.GL_DEPTH_BUFFER_BIT);
            gl.glMatrixMode(GL10.GL_MODELVIEW);gl.glLoadIdentity();GLU.gluLookAt(gl,0,3.1f,8.2f,0,1.1f,0,0,1,0);
            drawArena(gl);
            long now=System.currentTimeMillis();
            if(started&&!paused&&hp>0&&ehp>0){
                if(now-lastEnemy>1650){lastEnemy=now;if(Math.abs(playerX-enemyX)<2.65f&&!blocking){hp=Math.max(0,hp-(hero==2?5:8));message="RIVAL COUNTERATTACK!";}else if(Math.abs(playerX-enemyX)>=2.65f){enemyX+=enemyX>playerX?-.12f:.12f;}}
                if(now>attackUntil&&Math.abs(playerX-enemyX)>2.65f)enemyX+=enemyX>playerX?-.012f:.012f;
                playerX=Math.max(-3.1f,Math.min(0.65f,playerX));enemyX=Math.max(-0.65f,Math.min(3.1f,enemyX));
            }
            drawFighter(gl,playerX,playerZ,colors[hero],true,now<attackUntil,hero,weapon,now);
            drawFighter(gl,enemyX,enemyZ,colors[(hero+1)%colors.length],false,now-lastEnemy<260,(hero+1)%4,(weapon+1)%4,now);
            if(started&&hp<=0)message="DEFEAT — TAP REMATCH";
            if(started&&ehp<=0)message="VICTORY! — TAP REMATCH";
        }
        void drawArena(GL10 gl){
            gl.glDisable(GL10.GL_LIGHTING);
            gl.glPushMatrix();gl.glTranslatef(0,-0.1f,0);
            gl.glColor4f(.035f,.07f,.13f,1);cube(gl,9,.12f,5);
            gl.glColor4f(.04f,.28f,.38f,1);
            gl.glLineWidth(1.5f);gl.glBegin(GL10.GL_LINES);
            for(int i=-8;i<=8;i++){gl.glVertex3f(i*.5f,.07f,-2.5f);gl.glVertex3f(i*.5f,.07f,2.5f);}
            for(int i=-5;i<=5;i++){gl.glVertex3f(-4,.07f,i*.5f);gl.glVertex3f(4,.07f,i*.5f);}
            gl.glEnd();gl.glPopMatrix();
            for(int i=0;i<8;i++){gl.glPushMatrix();gl.glTranslatef(-4.4f+i*1.25f,1.1f,-3.4f);gl.glColor4f(i%2==0?.04f:.12f,.10f,.22f,1);cube(gl,.25f,2.2f,.28f);gl.glPopMatrix();}
            gl.glEnable(GL10.GL_LIGHTING);
        }
        void mat(GL10 gl,int color){float r=((color>>16)&255)/255f,g=((color>>8)&255)/255f,b=(color&255)/255f;float[] d={r,g,b,1},s={.55f,.55f,.65f,1};gl.glMaterialfv(GL10.GL_FRONT_AND_BACK,GL10.GL_AMBIENT_AND_DIFFUSE,d,0);gl.glMaterialfv(GL10.GL_FRONT_AND_BACK,GL10.GL_SPECULAR,s,0);gl.glMaterialf(GL10.GL_FRONT_AND_BACK,GL10.GL_SHININESS,48);}
        void drawFighter(GL10 gl,float x,float z,int col,boolean player,boolean attack,int type,int wp,long now){
            float bob=(float)Math.sin(now/170.0+(player?0:1))*.035f;
            gl.glPushMatrix();gl.glTranslatef(x,bob,z);gl.glRotatef(player?18:-18,0,1,0);
            int dark=0xff172237,accent=col;
            // legs and armored boots
            gl.glPushMatrix();gl.glTranslatef(-.19f,.38f,0);gl.glRotatef((attack? -24: (float)Math.sin(now/240.0)*4),1,0,0);mat(gl,dark);cube(gl,.18f,.62f,.22f);gl.glTranslatef(0,-.29f,.09f);mat(gl,accent);cube(gl,.23f,.12f,.34f);gl.glPopMatrix();
            gl.glPushMatrix();gl.glTranslatef(.19f,.38f,0);gl.glRotatef(attack?18:(float)Math.sin(now/240.0)*4,1,0,0);mat(gl,dark);cube(gl,.18f,.62f,.22f);gl.glTranslatef(0,-.29f,.09f);mat(gl,accent);cube(gl,.23f,.12f,.34f);gl.glPopMatrix();
            gl.glPushMatrix();gl.glTranslatef(0,1.05f,0);mat(gl,accent);cube(gl,.58f,.68f,.34f);gl.glTranslatef(0,.02f,.19f);mat(gl,0xffd5eaff);cube(gl,.26f,.09f,.025f);gl.glPopMatrix();
            gl.glPushMatrix();gl.glTranslatef(0,1.58f,0);mat(gl,0xffd6a783);sphere(gl,.22f,.22f,.22f);gl.glTranslatef(0,.10f,0);mat(gl,dark);cube(gl,.42f,.13f,.4f);gl.glPopMatrix();
            // arms and fists
            for(int side=-1;side<=1;side+=2){gl.glPushMatrix();gl.glTranslatef(side*.39f,1.24f,0);gl.glRotatef(attack&&side==(player?1:-1)?-58:(float)Math.sin(now/220.0+side)*10,1,0,0);gl.glRotatef(side*12,0,0,1);mat(gl,accent);cube(gl,.17f,.48f,.20f);gl.glTranslatef(0,-.28f,.05f);mat(gl,0xffd7e3f1);sphere(gl,.13f,.13f,.13f);
                if(player&&wp>0&&side==1){gl.glTranslatef(.08f,-.04f,.1f);mat(gl,wp==1?0xff45efff:wp==2?0xffffb13b:0xffc1a7ff);cube(gl,wp==2?.16f:.06f,wp==2?.58f:.65f,wp==2?.13f:.08f);}
                gl.glPopMatrix();}
            gl.glPopMatrix();
        }
        void cube(GL10 gl,float x,float y,float z){
            float[] v={-1,-1,1,1,-1,1,1,1,1,-1,1,1, 1,-1,-1,-1,-1,-1,-1,1,-1,1,1,-1, -1,-1,-1,-1,-1,1,-1,1,1,-1,1,-1, 1,-1,1,1,-1,-1,1,1,-1,1,1,1, -1,1,1,1,1,1,1,1,-1,-1,1,-1, -1,-1,-1,1,-1,-1,1,-1,1,-1,-1,1};
            FloatBuffer buf=ByteBuffer.allocateDirect(v.length*4).order(ByteOrder.nativeOrder()).asFloatBuffer();buf.put(v).position(0);
            gl.glPushMatrix();gl.glScalef(x/2,y/2,z/2);gl.glEnableClientState(GL10.GL_VERTEX_ARRAY);gl.glVertexPointer(3,GL10.GL_FLOAT,0,buf);gl.glDrawArrays(GL10.GL_QUADS,0,24);gl.glDisableClientState(GL10.GL_VERTEX_ARRAY);gl.glPopMatrix();
        }
        void sphere(GL10 gl,float x,float y,float z){cube(gl,x,y,z);}
        synchronized void action(String a){
            if(a.equals("START")||a.equals("REMATCH")){started=true;paused=false;hp=100;ehp=100;score=0;combo=0;playerX=-1.15f;enemyX=1.15f;lastEnemy=System.currentTimeMillis();message="FIGHT!";return;}
            if(a.equals("PAUSE")){paused=!paused;message=paused?"PAUSED":"FIGHT!";return;}
            if(a.equals("HERO")){hero=(hero+1)%4;message="FIGHTER: "+names[hero];return;}
            if(a.equals("WEAPON")){weapon=(weapon+1)%4;message=weapons[weapon];return;}
            if(!started||paused||hp<=0||ehp<=0)return;
            if(a.equals("LEFT")){playerX-=.22f;message="MOVE LEFT";}
            else if(a.equals("RIGHT")){playerX+=.22f;message="MOVE RIGHT";}
            else if(a.equals("BLOCK")){blocking=true;new Thread(()->{try{Thread.sleep(500);}catch(Exception ignored){}blocking=false;}).start();message="BLOCK!";}
            else if(a.equals("PUNCH")||a.equals("KICK")||a.equals("SPECIAL")){
                long now=System.currentTimeMillis();if(now-attackUntil<170)return;attackUntil=now+(a.equals("SPECIAL")?650:330);
                if(Math.abs(playerX-enemyX)<2.85f){int d=a.equals("PUNCH")?10:a.equals("KICK")?17:hero==2?36:27;ehp=Math.max(0,ehp-d);score+=d*10;combo++;message=a.equals("SPECIAL")?"ULTIMATE STRIKE!":a.equals("KICK")?"HEAVY KICK!":"PUNCH COMBO!";}
                else message="MOVE CLOSER!";
            }else if(a.equals("JUMP")){playerZ=-.55f;message="JUMP!";new Thread(()->{try{Thread.sleep(350);}catch(Exception ignored){}playerZ=0;}).start();}
        }
    }
    static class HUD extends View {
        final GameSurface game;final Paint p=new Paint(3);
        HUD(Context c,GameSurface g){super(c);game=g;setLayerType(View.LAYER_TYPE_SOFTWARE,null);}
        void fill(Canvas c,int col){p.setColor(col);p.setStyle(Paint.Style.FILL);p.setShader(null);}
        void box(Canvas c,float l,float t,float r,float b,int col){fill(c,col);c.drawRoundRect(l,t,r,b,16,16,p);}
        void label(Canvas c,String s,float x,float y,float size,int col,boolean bold){fill(c,col);p.setTextSize(size);p.setTypeface(Typeface.create("sans-serif-condensed",bold?1:0));c.drawText(s,x,y,p);}
        void center(Canvas c,String s,float x,float y,float size,int col){fill(c,col);p.setTextSize(size);p.setTypeface(Typeface.DEFAULT_BOLD);c.drawText(s,x-p.measureText(s)/2,y,p);}
        @Override protected void onDraw(Canvas c){
            int w=getWidth(),h=getHeight();World a=game.world;
            box(c,w*.025f,h*.035f,w*.36f,h*.105f,0xcc091526);label(c,a.names[a.hero],w*.045f,h*.075f,Math.min(23,w*.03f),Color.WHITE,true);box(c,w*.045f,h*.085f,w*.345f,h*.10f,0xff283449);box(c,w*.045f,h*.085f,w*(.045f+.30f*a.hp/100f),h*.10f,a.colors[a.hero]);
            box(c,w*.64f,h*.035f,w*.975f,h*.105f,0xcc091526);label(c,"RIVAL",w*.66f,h*.075f,Math.min(23,w*.03f),Color.WHITE,true);box(c,w*.66f,h*.085f,w*.955f,h*.10f,0xff283449);box(c,w*.66f,h*.085f,w*(.66f+.295f*a.ehp/100f),h*.10f,0xffff4b72);
            center(c,"SCORE  "+a.score,w*.50f,h*.075f,Math.min(20,w*.026f),0xffffd36b);
            box(c,w*.30f,h*.13f,w*.70f,h*.19f,0xd90a1527);center(c,a.message,w*.50f,h*.168f,Math.min(23,w*.033f),Color.WHITE);
            if(!a.started||a.hp<=0||a.ehp<=0){
                box(c,w*.33f,h*.34f,w*.67f,h*.47f,0xe60a1527);center(c,"KING FIGHTER 3D",w*.50f,h*.385f,Math.min(30,w*.045f),0xff4beaff);center(c,a.started?(a.ehp<=0?"VICTORY!":"DEFEAT"):"3D ARENA COMBAT",w*.50f,h*.425f,Math.min(21,w*.03f),Color.WHITE);
                button(c,w*.39f,h*.49f,w*.61f,h*.58f,a.started?"REMATCH":"START FIGHT",0xff087fb8);button(c,w*.39f,h*.60f,w*.61f,h*.68f,"CHANGE FIGHTER",0xff60418d);
            }else{
                button(c,w*.02f,h*.80f,w*.12f,h*.92f,"◀",0xff174b73);button(c,w*.135f,h*.80f,w*.235f,h*.92f,"▶",0xff174b73);
                button(c,w*.31f,h*.80f,w*.43f,h*.92f,"PUNCH",0xffa32d53);button(c,w*.445f,h*.80f,w*.565f,h*.92f,"KICK",0xffa85c1c);
                button(c,w*.58f,h*.80f,w*.73f,h*.92f,"SPECIAL",0xff65409c);button(c,w*.745f,h*.80f,w*.845f,h*.92f,"BLOCK",0xff18746d);button(c,w*.86f,h*.80f,w*.96f,h*.92f,"JUMP",0xff31527b);
                button(c,w*.90f,h*.03f,w*.975f,h*.12f,"Ⅱ",0xff26384f);button(c,w*.025f,h*.15f,w*.22f,h*.22f,"FIGHTER",0xff26384f);button(c,w*.025f,h*.235f,w*.22f,h*.305f,"WEAPON",0xff26384f);
                if(a.paused){box(c,w*.34f,h*.35f,w*.66f,h*.62f,0xee091526);center(c,"PAUSED",w*.5f,h*.43f,32,Color.WHITE);button(c,w*.40f,h*.48f,w*.60f,h*.56f,"RESUME",0xff087fb8);}
            }
            postInvalidateDelayed(80);
        }
        void button(Canvas c,float l,float t,float r,float b,String s,int col){box(c,l,t+4,r,b+4,0x99000000);box(c,l,t,r,b,col);fill(c,0xffd8f6ff);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(1.4f);c.drawRoundRect(l,t,r,b,14,14,p);p.setStyle(Paint.Style.FILL);center(c,s,(l+r)/2,(t+b)/2+6,Math.min(19,(r-l)/Math.max(4,s.length())*1.45f),Color.WHITE);}
        @Override public boolean onTouchEvent(android.view.MotionEvent e){
            if(e.getAction()!=MotionEvent.ACTION_UP)return true;
            float x=e.getX()/getWidth(),y=e.getY()/getHeight();World a=game.world;
            if(!a.started||a.hp<=0||a.ehp<=0){
                if(y>.47f&&y<.59f){game.act(a.started?"REMATCH":"START");}
                else if(y>.59f&&y<.70f){game.act("HERO");}
            }else if(a.paused){game.act("PAUSE");}
            else if(y<.13f&&x>.87f){game.act("PAUSE");}
            else if(y>.78f){
                if(x<.125f)game.act("LEFT");else if(x<.25f)game.act("RIGHT");else if(x<.44f)game.act("PUNCH");else if(x<.575f)game.act("KICK");else if(x<.74f)game.act("SPECIAL");else if(x<.855f)game.act("BLOCK");else game.act("JUMP");
            }else if(y>.13f&&y<.23f&&x<.24f)game.act("HERO");
            else if(y>.23f&&y<.32f&&x<.24f)game.act("WEAPON");
            invalidate();return true;
        }
    }
}
