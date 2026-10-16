package com.kingfighter.game;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.*;
import android.view.*;
import android.content.Context;

public class MainActivity extends Activity {
    @Override public void onCreate(Bundle b) { super.onCreate(b); getWindow().getDecorView().setSystemUiVisibility(5894 | 1024 | 512); setContentView(new FightView(this)); }

    static class FightView extends View {
        Paint p = new Paint(3);
        int playerX=180, enemyX=700, playerHp=100, enemyHp=100, score=0;
        boolean attacking=false, gameOver=false;
        long lastHit=0;
        FightView(Context c){super(c); setLayerType(View.LAYER_TYPE_SOFTWARE,null);}
        void text(Canvas c,String s,float x,float y,float size,int color){p.setColor(color);p.setTextSize(size);p.setTypeface(Typeface.create("sans-serif-condensed",Typeface.BOLD));c.drawText(s,x,y,p);}
        @Override protected void onDraw(Canvas c){
            int w=getWidth(),h=getHeight();
            c.drawColor(Color.rgb(13,18,36));
            p.setShader(new LinearGradient(0,0,w,h,Color.rgb(18,34,68),Color.rgb(72,20,46),Shader.TileMode.CLAMP)); c.drawRect(0,0,w,h,p); p.setShader(null);
            p.setColor(Color.rgb(34,38,55)); c.drawRect(0,h*.70f,w,h,p);
            p.setColor(Color.rgb(68,75,96)); c.drawRect(0,h*.70f,w,h*.715f,p);
            text(c,"KING FIGHTER",w*.36f,45,30,Color.WHITE);
            text(c,"PLAYER",35,45,17,Color.WHITE); text(c,"RIVAL",w-135,45,17,Color.WHITE);
            bar(c,30,58,w*.31f,15,playerHp,Color.rgb(28,220,120)); bar(c,w*.66f,58,w*.31f,15,enemyHp,Color.rgb(255,65,83));
            fighter(c,playerX,(int)(h*.70f),Color.rgb(25,190,255),true);
            fighter(c,enemyX,(int)(h*.70f),Color.rgb(255,66,92),false);
            text(c,"SCORE  "+score,w*.44f,85,18,Color.WHITE);
            if(gameOver){text(c,playerHp>0?"VICTORY!":"DEFEATED",w*.37f,h*.43f,42,Color.YELLOW);text(c,"TAP RESTART",w*.40f,h*.51f,20,Color.WHITE);}
            else {
                button(c,45,h-76,120,52,"MOVE",Color.rgb(40,105,190));
                button(c,180,h-76,130,52,"PUNCH",Color.rgb(205,50,75));
                button(c,w-170,h-76,125,52,"KICK",Color.rgb(220,130,30));
                text(c,"Move closer, then attack!",w*.37f,h-20,16,Color.WHITE);
            }
        }
        void bar(Canvas c,float x,float y,float w,float h,int hp,int color){p.setColor(Color.DKGRAY);c.drawRoundRect(x,y,x+w,y+h,8,8,p);p.setColor(color);c.drawRoundRect(x,y,x+w*Math.max(0,hp)/100f,y+h,8,8,p);}
        void button(Canvas c,float x,float y,float w,float h,String s,int color){p.setColor(color);c.drawRoundRect(x,y,x+w,y+h,14,14,p);text(c,s,x+22,y+33,19,Color.WHITE);}
        void fighter(Canvas c,int x,int floor,int color,boolean left){
            p.setColor(Color.argb(80,0,0,0));c.drawOval(x-30,floor-5,x+30,floor+8,p);
            p.setColor(color);c.drawCircle(x,floor-95,24,p);c.drawRoundRect(x-22,floor-72,x+22,floor-22,12,12,p);
            p.setStrokeWidth(12);p.setStrokeCap(Paint.Cap.ROUND);p.setColor(color);c.drawLine(x-12,floor-58,x+(left?35:-35),floor-43,p);c.drawLine(x+12,floor-58,x+(left?-35:35),floor-42,p);c.drawLine(x-10,floor-25,x-25,floor,p);c.drawLine(x+10,floor-25,x+25,floor,p);
            p.setStrokeWidth(1);
            if(attacking && System.currentTimeMillis()-lastHit<180){p.setColor(Color.YELLOW);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(5);c.drawCircle(x+(left?50:-50),floor-60,22,p);p.setStyle(Paint.Style.FILL);p.setStrokeWidth(1);}
        }
        @Override public boolean onTouchEvent(android.view.MotionEvent e){
            if(e.getAction()!=MotionEvent.ACTION_DOWN)return true;
            float x=e.getX(), y=e.getY(), w=getWidth(),h=getHeight();
            if(gameOver){playerHp=100;enemyHp=100;score=0;gameOver=false;playerX=180;enemyX=(int)(w-180);invalidate();return true;}
            if(y>h-100){
                if(x<160)playerX=Math.min(enemyX-70,playerX+35);
                else if(x<340){if(Math.abs(enemyX-playerX)<210){enemyHp-=12;score+=10;attacking=true;lastHit=System.currentTimeMillis();}}
                else if(x>w-210){if(Math.abs(enemyX-playerX)<250){enemyHp-=20;score+=20;attacking=true;lastHit=System.currentTimeMillis();}}
                if(enemyHp<=0){enemyHp=0;gameOver=true;} else if(Math.abs(enemyX-playerX)<230 && (x<340 || x>w-210)){playerHp-=7;if(playerHp<=0){playerHp=0;gameOver=true;}}
            } else {playerX=Math.min(enemyX-65,playerX+20);}
            invalidate();postInvalidateDelayed(200);return true;
        }
    }
}
