package com.kingfighter.game;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.*;
import android.view.*;
import android.content.Context;
import android.os.Vibrator;
import android.os.Build;
import android.graphics.drawable.GradientDrawable;
import java.util.Random;

public class MainActivity extends Activity {
    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setFlags(1024,1024);
        getWindow().getDecorView().setSystemUiVisibility(5894 | 1024 | 512 | 4096);
        setContentView(new ArenaView(this));
    }

    static class ArenaView extends View {
        final Paint p=new Paint(3);
        final Random random=new Random(9);
        final int GOLD=Color.rgb(255,194,70), CYAN=Color.rgb(53,226,255), RED=Color.rgb(255,64,100), WHITE=Color.WHITE;
        int screen=0, mode=0, hero=0, enemy=1, hp=100, ehp=100, energy=0, score=0, wins=0, combo=0;
        int playerX=0, enemyX=0, round=1, timeLeft=99;
        boolean initialized=false, sound=true, paused=false, hitFlash=false;
        long lastAction=0, lastTick=System.currentTimeMillis();
        float pulse=0, bgShift=0;
        String toast="", difficulty="NORMAL";
        long toastAt=0;
        final String[] heroes={"VOLT","SHADOW","TITAN"};
        final int[] heroColors={0xff27d9ff,0xffb15cff,0xffffa63d};
        final String[] styles={"SPEED FIGHTER","NIGHT ASSASSIN","POWER TANK"};
        ArenaView(Context c){super(c);setLayerType(View.LAYER_TYPE_SOFTWARE,null);}
        void color(int c){p.setColor(c);p.setShader(null);p.setStyle(Paint.Style.FILL);p.setShadowLayer(0,0,0,Color.TRANSPARENT);}
        void rect(Canvas c,float l,float t,float r,float b,int col){color(col);c.drawRect(l,t,r,b,p);}
        void round(Canvas c,float l,float t,float r,float b,float rad,int col){color(col);c.drawRoundRect(l,t,r,b,rad,rad,p);}
        void line(Canvas c,float x1,float y1,float x2,float y2,float width,int col){color(col);p.setStrokeWidth(width);p.setStrokeCap(Paint.Cap.ROUND);c.drawLine(x1,y1,x2,y2,p);p.setStrokeWidth(1);}
        void txt(Canvas c,String s,float x,float y,float size,int col,boolean bold){
            color(col);p.setTextSize(size);p.setTypeface(Typeface.create("sans-serif-condensed",bold?Typeface.BOLD:Typeface.NORMAL));p.setLetterSpacingCompat(0);c.drawText(s,x,y,p);
        }
        void centered(Canvas c,String s,float x,float y,float size,int col,boolean bold){color(col);p.setTextSize(size);p.setTypeface(Typeface.create("sans-serif-condensed",bold?Typeface.BOLD:Typeface.NORMAL));c.drawText(s,x-p.measureText(s)/2,y,p);}
        void glowText(Canvas c,String s,float x,float y,float size,int col){color(col);p.setTextSize(size);p.setTypeface(Typeface.create("sans-serif-condensed",Typeface.BOLD));p.setShadowLayer(18,0,0,col);c.drawText(s,x,y,p);p.clearShadowLayer();}
        void panel(Canvas c,float l,float t,float r,float b){
            color(0xdd10192b);p.setStyle(Paint.Style.FILL);c.drawRoundRect(l,t,r,b,20,20,p);
            color(0xff31465f);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(1.5f);c.drawRoundRect(l,t,r,b,20,20,p);p.setStyle(Paint.Style.FILL);
        }
        void button(Canvas c,float l,float t,float r,float b,String label,int accent,boolean active){
            round(c,l+3,t+5,r+3,b+5,15,0x99000000);
            round(c,l,t,r,b,15,active?accent:0xff1b2940);
            color(active?0xfffff0c9:0xff425875);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(1.5f);c.drawRoundRect(l,t,r,b,15,15,p);p.setStyle(Paint.Style.FILL);
            centered(c,label,(l+r)/2,(t+b)/2+7,Math.min(21,(r-l)/Math.max(4,label.length())*1.45f),WHITE,true);
        }
        @Override protected void onDraw(Canvas c){
            super.onDraw(c);int w=getWidth(),h=getHeight();if(w<1||h<1)return;
            if(!initialized){playerX=(int)(w*.28f);enemyX=(int)(w*.72f);initialized=true;}
            float dt=Math.min(0.05f,(System.currentTimeMillis()-lastTick)/1000f);lastTick=System.currentTimeMillis();pulse+=dt*2.2f;bgShift+=dt*8;
            drawBackground(c,w,h);
            if(screen==0)drawMenu(c,w,h);
            else if(screen==1)drawSelect(c,w,h);
            else if(screen==2)drawFight(c,w,h);
            else if(screen==3)drawSettings(c,w,h);
            else if(screen==4)drawResult(c,w,h);
            if(!toast.isEmpty()&&System.currentTimeMillis()-toastAt<1800){round(c,w*.33f,h*.08f,w*.67f,h*.16f,18,0xee111a2b);centered(c,toast,w/2f,h*.13f,19,GOLD,true);}
            postInvalidateDelayed(33);
        }
        void drawBackground(Canvas c,int w,int h){
            p.setShader(new LinearGradient(0,0,w,h,0xff07101f,0xff32152d,Shader.TileMode.CLAMP));c.drawRect(0,0,w,h,p);p.setShader(null);
            color(0x3327cfff);c.drawCircle(w*.78f,h*.22f,h*.18f,p);
            color(0x22ff3e7d);c.drawCircle(w*.18f,h*.28f,h*.20f,p);
            // neon skyline
            for(int i=0;i<14;i++){float bw=w/14f+4;float bh=h*(.15f+((i*37)%31)/100f);float x=i*bw;rect(c,x,h*.70f-bh,x+bw-3,h*.70f,0xff111a30);for(int j=0;j<3;j++)for(int k=0;k<2;k++)if((i+j+k)%3!=0)rect(c,x+5+k*9,h*.70f-bh+8+j*13,x+9+k*9,h*.70f-bh+13+j*13,0x8860b9d9);}
            rect(c,0,h*.70f,w,h,0xff111624);rect(c,0,h*.70f,w,h*.715f,0xff506178);
            for(int i=0;i<9;i++){float x=(i*w/8f+(bgShift%w));while(x>w)x-=w;line(c,x,h*.72f,x-35,h,1,0x3348a9ca);}
            line(c,0,h*.88f,w,h*.88f,1,0x55ffbf55);
        }
        void drawLogo(Canvas c,int w,int h,float y){
            centered(c,"KING",w/2f,y,Math.min(72,w*.12f),WHITE,true);
            centered(c,"F I G H T E R",w/2f,y+Math.min(36,h*.065f),Math.min(25,w*.045f),GOLD,true);
            round(c,w*.38f,y+Math.min(46,h*.085f),w*.62f,y+Math.min(49,h*.09f),2,CYAN);
        }
        void drawMenu(Canvas c,int w,int h){
            drawLogo(c,w,h*.16f);
            centered(c,"RISE. FIGHT. RULE THE ARENA.",w/2f,h*.39f,Math.min(22,w*.035f),0xffb8c9df,true);
            float bw=Math.min(300,w*.42f), bh=Math.min(55,h*.105f), x=(w-bw)/2;
            button(c,x,h*.48f,x+bw,h*.48f+bh,"PLAY NOW",0xff087dba,true);
            button(c,x,h*.48f+bh+13,x+bw,h*.48f+bh*2+13,"TRAINING MODE",0xff60418d,false);
            button(c,x,h*.48f+bh*2+26,x+bw,h*.48f+bh*3+26,"SETTINGS",0xff263c59,false);
            centered(c,"3 FIGHTERS  •  COMBOS  •  ARCADE BATTLES",w/2f,h*.91f,Math.min(16,w*.025f),0xff9aaec8,false);
            centered(c,"v1.1  |  OFFLINE FIGHTING",w/2f,h*.96f,12,0xff61758e,false);
            drawEmblem(c,w*.16f,h*.55f,Math.min(42,h*.08f),CYAN,true);drawEmblem(c,w*.84f,h*.55f,Math.min(42,h*.08f),RED,false);
        }
        void drawEmblem(Canvas c,float x,float y,float r,int col,boolean left){
            color(col);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(3);Path path=new Path();path.moveTo(x,y-r);path.lineTo(x+r*.8f,y-r*.45f);path.lineTo(x+r*.65f,y+r*.55f);path.lineTo(x,y+r);path.lineTo(x-r*.65f,y+r*.55f);path.lineTo(x-r*.8f,y-r*.45f);path.close();c.drawPath(path,p);p.setStyle(Paint.Style.FILL);
            line(c,x-r*.35f,y-r*.12f,x+r*.35f,y-r*.12f,3,col);line(c,x-r*.28f,y+r*.2f,x+r*.28f,y+r*.2f,3,col);
        }
        void drawSelect(Canvas c,int w,int h){
            centered(c,"CHOOSE YOUR FIGHTER",w/2f,h*.13f,Math.min(34,w*.055f),WHITE,true);
            centered(c,"Every warrior has a different fighting style",w/2f,h*.19f,17,0xffb5c6dd,false);
            float gap=w*.025f, cw=Math.min(w*.27f,250), total=cw*3+gap*2, start=(w-total)/2;
            for(int i=0;i<3;i++){
                float x=start+i*(cw+gap);panel(c,x,h*.25f,x+cw,h*.76f);
                int col=heroColors[i];if(hero==i){color(col);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(3);c.drawRoundRect(x,h*.25f,x+cw,h*.76f,20,20,p);p.setStyle(Paint.Style.FILL);}
                drawEmblem(c,x+cw/2,h*.41f,Math.min(35,cw*.15f),col,true);
                centered(c,heroes[i],x+cw/2,h*.54f,Math.min(30,cw*.15f),WHITE,true);
                centered(c,styles[i],x+cw/2,h*.59f,Math.min(14,cw*.075f),col,true);
                centered(c,i==0?"SPEED  ★★★★★":i==1?"SKILL  ★★★★★":"POWER  ★★★★★",x+cw/2,h*.65f,Math.min(15,cw*.08f),0xffd4deee,false);
                button(c,x+cw*.14f,h*.68f,x+cw*.86f,h*.68f+36,i==hero?"SELECTED":"CHOOSE",col,i==hero);
            }
            button(c,w*.08f,h*.84f,w*.28f,h*.84f+48,"BACK",0xff263c59,false);
            button(c,w*.36f,h*.84f,w*.64f,h*.84f+48,"ENTER ARENA",0xff087dba,true);
            button(c,w*.72f,h*.84f,w*.92f,h*.84f+48,"NEXT FIGHTER",0xff60418d,false);
        }
        void fighter(Canvas c,int x,int floor,int col,boolean facingRight,int index,boolean attack){
            float sc=Math.max(.7f,Math.min(1.25f,getHeight()/480f));int head=(int)(21*sc), body=(int)(52*sc);
            color(0x77000000);c.drawOval(x-32*sc,floor-4,x+32*sc,floor+9,p);
            // glowing aura
            color(col&0x33ffffff);c.drawCircle(x,floor-75*sc,45*sc,p);
            color(col);c.drawCircle(x,floor-body-head,head,p);
            // headband
            rect(c,x-20*sc,floor-body-head-4*sc,x+20*sc,floor-body-head+2*sc,0xfff4f7ff);
            line(c,x+ (facingRight?8:-8)*sc,floor-body-head,x+(facingRight?16:-16)*sc,floor-body-head+2*sc,2,0xff101626);
            // torso
            color(col);Path torso=new Path();torso.moveTo(x-23*sc,floor-body);torso.lineTo(x-17*sc,floor-body-16*sc);torso.lineTo(x+17*sc,floor-body-16*sc);torso.lineTo(x+23*sc,floor-body);torso.close();c.drawPath(torso,p);
            line(c,x-12*sc,floor-body+2*sc,x-28*sc,floor-20*sc,12*sc,col);
            line(c,x+12*sc,floor-body+2*sc,x+28*sc,floor-20*sc,12*sc,col);
            float armX=x+(facingRight?43:-43)*sc;
            if(attack){line(c,x+(facingRight?12:-12)*sc,floor-body+2*sc,x+(facingRight?78:-78)*sc,floor-body+1*sc,13*sc,col);color(GOLD);p.setShadowLayer(16,0,0,GOLD);c.drawCircle(x+(facingRight?82:-82)*sc,floor-body,12*sc,p);p.clearShadowLayer();}
            line(c,x-10*sc,floor-19*sc,x-25*sc,floor,13*sc,col);line(c,x+10*sc,floor-19*sc,x+25*sc,floor,13*sc,col);
            line(c,x-28*sc,floor-3*sc,x-12*sc,floor-3*sc,8*sc,0xffdceaff);line(c,x+15*sc,floor-3*sc,x+31*sc,floor-3*sc,8*sc,0xffdceaff);
        }
        void drawFight(Canvas c,int w,int h){
            if(!paused&&!isOver()){
                long now=System.currentTimeMillis();
                if(now-lastAction>6500){timeLeft=Math.max(0,timeLeft-1);lastAction=now;if(timeLeft==0){screen=4;}}
            }
            txt(c,"ROUND "+round, w*.45f,h*.07f,18,GOLD,true);
            txt(c,"P"+(hero+1)+"  "+heroes[hero],w*.04f,h*.07f,16,WHITE,true);
            txt(c,"RIVAL  "+heroes[enemy],w*.77f,h*.07f,16,WHITE,true);
            bar(c,w*.04f,h*.10f,w*.36f,17,hp,heroColors[hero]);
            bar(c,w*.60f,h*.10f,w*.36f,17,ehp,RED);
            centered(c,""+timeLeft,w/2f,h*.13f,20,WHITE,true);
            fighter(c,playerX,(int)(h*.72f),heroColors[hero],true,hero,System.currentTimeMillis()-lastAction<250&&combo>0);
            fighter(c,enemyX,(int)(h*.72f),heroColors[enemy],false,enemy,false);
            if(combo>1)glowText(c,combo+" HIT COMBO!",w*.42f,h*.34f,27,GOLD);
            // controls
            float by=h*.80f,bh=h*.13f;
            button(c,w*.035f,by,w*.17f,by+bh,"MOVE",0xff1b507a,false);
            button(c,w*.205f,by,w*.36f,by+bh,"PUNCH",0xffa12e51,true);
            button(c,w*.375f,by,w*.53f,by+bh,"KICK",0xffa35b1c,true);
            button(c,w*.70f,by,w*.86f,by+bh,"SPECIAL",0xff62419b,true);
            button(c,w*.88f,by,w*.97f,by+bh,"Ⅱ",0xff263c59,false);
            if(paused){rect(c,0,0,w,h,0xbb050a15);panel(c,w*.30f,h*.27f,w*.70f,h*.73f);centered(c,"PAUSED",w/2f,h*.38f,36,WHITE,true);button(c,w*.37f,h*.44f,w*.63f,h*.44f+45,"RESUME",0xff087dba,true);button(c,w*.37f,h*.55f,w*.63f,h*.55f+45,"MAIN MENU",0xff263c59,false);}
        }
        void bar(Canvas c,float x,float y,float ww,float hh,int val,int col){round(c,x,y,x+ww,y+hh,hh/2,0xff27344a);round(c,x,y,x+ww*Math.max(0,val)/100f,y+hh,hh/2,col);round(c,x,y,x+ww*Math.max(0,val)/100f,y+3,2,0x66ffffff);}
        boolean isOver(){return hp<=0||ehp<=0;}
        void drawResult(Canvas c,int w,int h){
            boolean won=ehp<=0;
            drawEmblem(c,w/2f,h*.28f,55,won?GOLD:RED,true);
            centered(c,won?"VICTORY!":"DEFEAT",w/2f,h*.45f,Math.min(58,w*.09f),won?GOLD:RED,true);
            centered(c,won?"THE ARENA IS YOURS":"GET BACK UP, FIGHTER",w/2f,h*.52f,20,WHITE,true);
            centered(c,"SCORE  "+score+"     COMBO  x"+Math.max(combo,1),w/2f,h*.60f,21,0xffc5d5e9,false);
            button(c,w*.28f,h*.70f,w*.48f,h*.70f+52,"REMATCH",0xff087dba,true);
            button(c,w*.52f,h*.70f,w*.75f,h*.70f+52,"MAIN MENU",0xff263c59,false);
        }
        void drawSettings(Canvas c,int w,int h){
            centered(c,"GAME SETTINGS",w/2f,h*.18f,Math.min(38,w*.06f),WHITE,true);
            panel(c,w*.20f,h*.28f,w*.80f,h*.72f);
            txt(c,"SOUND",w*.27f,h*.40f,23,WHITE,true);button(c,w*.60f,h*.34f,w*.75f,h*.34f+44,sound?"ON":"OFF",0xff087dba,sound);
            txt(c,"DIFFICULTY",w*.27f,h*.52f,23,WHITE,true);button(c,w*.60f,h*.46f,w*.75f,h*.46f+44,difficulty,0xff60418d,true);
            centered(c,"Built for offline arcade fun",w/2f,h*.63f,16,0xffaebfd5,false);
            button(c,w*.36f,h*.79f,w*.64f,h*.79f+48,"BACK TO MENU",0xff263c59,false);
        }
        void startFight(){screen=2;paused=false;hp=100;ehp=100;energy=0;combo=0;timeLeft=99;score=0;playerX=(int)(getWidth()*.28f);enemyX=(int)(getWidth()*.72f);lastAction=System.currentTimeMillis();}
        void notice(String s){toast=s;toastAt=System.currentTimeMillis();}
        void vibrate(){try{Vibrator v=(Vibrator)getContext().getSystemService(Context.VIBRATOR_SERVICE);if(v!=null&&Build.VERSION.SDK_INT>=26)v.vibrate(android.os.VibrationEffect.createOneShot(22,70));}catch(Exception ignored){}}
        @Override public boolean onTouchEvent(android.view.MotionEvent e){
            if(e.getAction()!=MotionEvent.ACTION_DOWN)return true;
            float x=e.getX(),y=e.getY(),w=getWidth(),h=getHeight();
            if(screen==0){
                if(y>h*.45f&&y<h*.48f+Math.min(55,h*.105f)){screen=1;}
                else if(y>h*.48f&&y<h*.48f+Math.min(55,h*.105f)+75){mode=1;screen=1;notice("TRAINING MODE");}
                else if(y>h*.48f+Math.min(55,h*.105f)+70){screen=3;}
            }else if(screen==1){
                float cw=Math.min(w*.27f,250),gap=w*.025f,total=cw*3+gap*2,start=(w-total)/2;
                for(int i=0;i<3;i++){float left=start+i*(cw+gap);if(x>=left&&x<=left+cw&&y>h*.24f&&y<h*.78f){hero=i;return true;}}
                if(y>h*.82f&&x<w*.32f)screen=0;
                else if(y>h*.82f&&x>w*.33f&&x<w*.68f){enemy=(hero+1+random.nextInt(2))%3;startFight();}
                else if(y>h*.82f&&x>w*.70f)hero=(hero+1)%3;
            }else if(screen==2){
                if(paused){if(y>h*.42f&&y<h*.53f)paused=false;else if(y>h*.53f){screen=0;paused=false;} }
                else if(y>h*.78f){
                    if(x>w*.87f){paused=true;return true;}
                    if(x<w*.19f){playerX=Math.min(enemyX-75,playerX+Math.max(24,(int)(w*.07f)));notice("MOVE!");}
                    else if(x<w*.37f){attack(12,"PUNCH!");}
                    else if(x<w*.56f){attack(18,"POWER KICK!");}
                    else if(x>w*.65f){attack(28,"SPECIAL ATTACK!");energy=0;}
                }else if(x<w*.45f){playerX=Math.min(enemyX-70,playerX+25);}
                else {playerX=Math.min(enemyX-65,playerX+10);}
                if(ehp<=0||hp<=0){screen=4;if(ehp<=0)wins++;}
            }else if(screen==3){
                if(y>h*.33f&&y<h*.44f)sound=!sound;
                else if(y>h*.45f&&y<h*.56f)difficulty=difficulty.equals("NORMAL")?"HARD":difficulty.equals("HARD")?"EASY":"NORMAL";
                else screen=0;
            }else if(screen==4){
                if(y>h*.66f&&x<w*.50f)startFight();else if(y>h*.66f)screen=0;
            }
            vibrate();invalidate();return true;
        }
        void attack(int damage,String label){
            if(Math.abs(enemyX-playerX)>getWidth()*.43f){notice("TOO FAR — MOVE CLOSER");playerX=Math.min(enemyX-90,playerX+25);return;}
            ehp=Math.max(0,ehp-damage);combo++;score+=damage*10;energy=Math.min(100,energy+damage);lastAction=System.currentTimeMillis();notice(label);vibrate();
            if(ehp>0){int retaliation=difficulty.equals("HARD")?13:difficulty.equals("EASY")?4:8;hp=Math.max(0,hp-retaliation);if(hp>0&&random.nextInt(4)==0)enemyX=Math.max(playerX+95,enemyX-15);}
            if(ehp==0){wins++;screen=4;}else if(hp==0)screen=4;
        }
    }
}
