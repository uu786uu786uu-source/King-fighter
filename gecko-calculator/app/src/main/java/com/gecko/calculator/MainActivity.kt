package com.gecko.calculator

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.*
import com.google.android.gms.ads.*
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback
import java.text.DecimalFormat
import kotlin.math.*

class MainActivity : Activity() {
    private val bg = Color.rgb(10, 20, 25)
    private val panel = Color.rgb(24, 39, 47)
    private val green = Color.rgb(50, 235, 83)
    private val white = Color.WHITE
    private lateinit var display: TextView
    private lateinit var historyView: TextView
    private lateinit var root: LinearLayout
    private var expression = ""
    private var lastAnswer = 0.0
    private val history = mutableListOf<String>()
    private var rewardedAd: RewardedAd? = null
    private val fmt = DecimalFormat("#,##0.########")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        MobileAds.initialize(this) {}
        loadRewardedAd()
        showCalculator()
    }

    private fun loadRewardedAd() {
        val request = AdRequest.Builder().build()
        RewardedAd.load(this, "ca-app-pub-9371973914123866/9175507151", request,
            object : RewardedAdLoadCallback() {
                override fun onAdLoaded(ad: RewardedAd) { rewardedAd = ad }
                override fun onAdFailedToLoad(error: LoadAdError) { rewardedAd = null }
            })
    }

    private fun showCalculator() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(16, 22, 16, 10)
            setBackgroundColor(bg)
        }
        val scroll = ScrollView(this)
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val title = TextView(this).apply {
            text = "🦎 Gecko Calculator"
            textSize = 27f; setTextColor(green); typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER; setPadding(0, 8, 0, 16)
        }
        content.addView(title)
        val tabs = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        listOf("Calculator", "Scientific", "Tools").forEach { label ->
            val b = Button(this).apply {
                text = label; isAllCaps = false
                setTextColor(white); setBackgroundColor(panel)
            }
            b.setOnClickListener {
                when (label) {
                    "Calculator" -> showCalculator()
                    "Scientific" -> showScientific()
                    else -> showTools()
                }
            }
            tabs.addView(b, LinearLayout.LayoutParams(0, -2, 1f))
        }
        content.addView(tabs)
        display = TextView(this).apply {
            text = "0"; textSize = 32f; gravity = Gravity.END or Gravity.CENTER_VERTICAL
            setTextColor(white); setBackgroundColor(panel); setPadding(16, 22, 16, 22)
        }
        content.addView(display, LinearLayout.LayoutParams(-1, 110).apply { setMargins(0, 12, 0, 12) })
        val rows = listOf(
            listOf("C", "(", ")", "⌫"),
            listOf("7", "8", "9", "÷"),
            listOf("4", "5", "6", "×"),
            listOf("1", "2", "3", "−"),
            listOf("%", "0", ".", "+"),
            listOf("History", "=", "BMI", "Discount")
        )
        rows.forEach { row ->
            val line = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            row.forEach { key ->
                val b = Button(this).apply {
                    text = key; isAllCaps = false; textSize = 17f
                    setTextColor(if (key == "=") Color.BLACK else white)
                    setBackgroundColor(if (key == "=") green else panel)
                }
                b.setOnClickListener { onKey(key) }
                line.addView(b, LinearLayout.LayoutParams(0, 58, 1f).apply { setMargins(3, 3, 3, 3) })
            }
            content.addView(line)
        }
        historyView = TextView(this).apply { setTextColor(white); textSize = 14f; setPadding(8, 10, 8, 8) }
        content.addView(historyView)
        scroll.addView(content)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        val adView = AdView(this).apply {
            adUnitId = "ca-app-pub-9371973914123866/8812481769"
            setAdSize(AdSize.BANNER)
            loadAd(AdRequest.Builder().build())
        }
        root.addView(adView, LinearLayout.LayoutParams(-1, -2))
        setContentView(root)
        updateDisplay()
    }

    private fun onKey(key: String) {
        when (key) {
            "C" -> expression = ""
            "⌫" -> if (expression.isNotEmpty()) expression = expression.dropLast(1)
            "=" -> {
                try {
                    val result = evaluate(expression)
                    lastAnswer = result
                    history.add("$expression = ${fmt.format(result)}")
                    expression = fmt.format(result).replace(",", "")
                    historyView.text = history.takeLast(8).asReversed().joinToString("\n")
                } catch (_: Exception) { display.text = "Invalid expression"; return }
            }
            "History" -> { historyView.text = if (history.isEmpty()) "No calculations yet" else history.asReversed().joinToString("\n"); return }
            "BMI" -> { showBmi(); return }
            "Discount" -> { showDiscount(); return }
            else -> expression += when (key) { "÷" -> "/"; "×" -> "*"; "−" -> "-"; "%" -> "/100"; else -> key }
        }
        updateDisplay()
    }

    private fun updateDisplay() { display.text = if (expression.isBlank()) "0" else expression }

    private fun showScientific() {
        showCalculator()
        val scientific = listOf("sin", "cos", "tan", "sqrt", "x²", "log", "ln", "π")
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        scientific.forEach { label ->
            val b = Button(this).apply { text = label; isAllCaps = false; setTextColor(white); setBackgroundColor(panel) }
            b.setOnClickListener {
                val x = expression.toDoubleOrNull() ?: 0.0
                expression = when (label) {
                    "sin" -> sin(Math.toRadians(x)).toString()
                    "cos" -> cos(Math.toRadians(x)).toString()
                    "tan" -> tan(Math.toRadians(x)).toString()
                    "sqrt" -> sqrt(x).toString()
                    "x²" -> (x*x).toString()
                    "log" -> log10(x).toString()
                    "ln" -> ln(x).toString()
                    else -> Math.PI.toString()
                }
                updateDisplay()
            }
            row.addView(b, LinearLayout.LayoutParams(0, 55, 1f))
        }
        root.addView(row, 1)
    }

    private fun showTools() {
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(18, 20, 18, 20); setBackgroundColor(bg) }
        val title = TextView(this).apply { text = "Gecko Tools"; textSize = 28f; setTextColor(green); gravity = Gravity.CENTER; setPadding(0, 0, 0, 20) }
        layout.addView(title)
        val options = listOf("Unit Converter", "Currency Converter", "Mortgage & Loan", "BMI Calculator", "Percentage & Discount", "Calculation History", "Dark Mode")
        options.forEach { option ->
            val b = Button(this).apply { text = option; isAllCaps = false; setTextColor(white); setBackgroundColor(panel) }
            b.setOnClickListener {
                when (option) {
                    "BMI Calculator" -> showBmi()
                    "Percentage & Discount" -> showDiscount()
                    "Calculation History" -> showAlert(if (history.isEmpty()) "No history yet" else history.asReversed().joinToString("\n"))
                    "Unit Converter" -> showUnitConverter()
                    "Currency Converter" -> showCurrency()
                    "Mortgage & Loan" -> showMortgage()
                    else -> { root.setBackgroundColor(Color.BLACK); showAlert("Dark mode is enabled") }
                }
            }
            layout.addView(b, LinearLayout.LayoutParams(-1, 54).apply { setMargins(0, 4, 0, 4) })
        }
        setContentView(layout)
    }

    private fun showBmi() {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24); setBackgroundColor(bg) }
        box.addView(TextView(this).apply { text = "BMI Calculator"; textSize = 26f; setTextColor(green) })
        val kg = EditText(this).apply { hint = "Weight in kg"; inputType = 8194 }
        val cm = EditText(this).apply { hint = "Height in cm"; inputType = 8194 }
        val result = TextView(this).apply { setTextColor(white); textSize = 20f }
        box.addView(kg); box.addView(cm)
        box.addView(Button(this).apply { text = "Calculate BMI"; setOnClickListener {
            val w = kg.text.toString().toDoubleOrNull(); val h = cm.text.toString().toDoubleOrNull()
            result.text = if (w != null && h != null && h > 0) "BMI: ${fmt.format(w / (h/100).pow(2))}" else "Enter valid values"
        }})
        box.addView(result)
        box.addView(backButton())
        setContentView(box)
    }

    private fun showDiscount() {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24); setBackgroundColor(bg) }
        box.addView(TextView(this).apply { text = "Discount Calculator"; textSize = 26f; setTextColor(green) })
        val price = EditText(this).apply { hint = "Original price"; inputType = 8194 }
        val percent = EditText(this).apply { hint = "Discount percent"; inputType = 8194 }
        val result = TextView(this).apply { setTextColor(white); textSize = 20f }
        box.addView(price); box.addView(percent)
        box.addView(Button(this).apply { text = "Calculate"; setOnClickListener {
            val p = price.text.toString().toDoubleOrNull(); val d = percent.text.toString().toDoubleOrNull()
            result.text = if (p != null && d != null) "Final price: ${fmt.format(p*(1-d/100))}\nYou save: ${fmt.format(p*d/100)}" else "Enter valid values"
        }})
        box.addView(result); box.addView(backButton()); setContentView(box)
    }

    private fun showUnitConverter() {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24); setBackgroundColor(bg) }
        box.addView(TextView(this).apply { text = "Length Converter"; textSize = 26f; setTextColor(green) })
        val value = EditText(this).apply { hint = "Value in meters"; inputType = 8194 }
        val result = TextView(this).apply { setTextColor(white); textSize = 20f }
        box.addView(value)
        box.addView(Button(this).apply { text = "Convert to km, cm, feet"; setOnClickListener {
            val v = value.text.toString().toDoubleOrNull()
            result.text = if (v != null) "Kilometers: ${fmt.format(v/1000)}\nCentimeters: ${fmt.format(v*100)}\nFeet: ${fmt.format(v*3.28084)}" else "Enter a valid number"
        }})
        box.addView(result); box.addView(backButton()); setContentView(box)
    }

    private fun showCurrency() {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24); setBackgroundColor(bg) }
        box.addView(TextView(this).apply { text = "Currency Converter (indicative rate)"; textSize = 23f; setTextColor(green) })
        val value = EditText(this).apply { hint = "Amount in USD"; inputType = 8194 }
        val result = TextView(this).apply { setTextColor(white); textSize = 20f }
        box.addView(value)
        box.addView(Button(this).apply { text = "Convert USD to PKR"; setOnClickListener {
            val v = value.text.toString().toDoubleOrNull()
            result.text = if (v != null) "PKR: ${fmt.format(v*284.50)}\nRate is an example and may be outdated." else "Enter a valid amount"
        }})
        box.addView(result); box.addView(backButton()); setContentView(box)
    }

    private fun showMortgage() {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24); setBackgroundColor(bg) }
        box.addView(TextView(this).apply { text = "Mortgage / Loan"; textSize = 26f; setTextColor(green) })
        val principal = EditText(this).apply { hint = "Loan amount"; inputType = 8194 }
        val rate = EditText(this).apply { hint = "Annual interest %"; inputType = 8194 }
        val years = EditText(this).apply { hint = "Years"; inputType = 2 }
        val result = TextView(this).apply { setTextColor(white); textSize = 20f }
        box.addView(principal); box.addView(rate); box.addView(years)
        box.addView(Button(this).apply { text = "Estimate monthly payment"; setOnClickListener {
            val p = principal.text.toString().toDoubleOrNull(); val r = rate.text.toString().toDoubleOrNull()?.div(1200); val n = years.text.toString().toDoubleOrNull()?.times(12)
            result.text = if (p != null && r != null && n != null && n > 0) {
                val pay = if (r == 0.0) p/n else p*r/(1-(1+r).pow(-n))
                "Estimated monthly payment: ${fmt.format(pay)}"
            } else "Enter valid values"
        }})
        box.addView(result); box.addView(backButton()); setContentView(box)
    }

    private fun backButton() = Button(this).apply { text = "Back to Calculator"; setOnClickListener { showCalculator() } }
    private fun showAlert(message: String) = android.app.AlertDialog.Builder(this).setTitle("Gecko Calculator").setMessage(message).setPositiveButton("OK", null).show()

    private fun evaluate(input: String): Double = ExpressionParser(input).parse()

    private class ExpressionParser(input: String) {
        private val source = input.replace(" ", "")
        private val tokens = Regex("\\d+(?:\\.\\d+)?|[()+\\-*/]").findAll(source).map { it.value }.toList()
        private var index = 0

        fun parse(): Double {
            if (source.isEmpty() || tokens.joinToString("") != source) throw IllegalArgumentException()
            val value = expression()
            if (index != tokens.size || !value.isFinite()) throw IllegalArgumentException()
            return value
        }

        private fun expression(): Double {
            var value = term()
            while (index < tokens.size && (tokens[index] == "+" || tokens[index] == "-")) {
                val op = tokens[index++]
                val right = term()
                value = if (op == "+") value + right else value - right
            }
            return value
        }

        private fun term(): Double {
            var value = factor()
            while (index < tokens.size && (tokens[index] == "*" || tokens[index] == "/")) {
                val op = tokens[index++]
                val right = factor()
                value = if (op == "*") value * right else value / right
            }
            return value
        }

        private fun factor(): Double {
            if (index >= tokens.size) throw IllegalArgumentException()
            return when (val token = tokens[index++]) {
                "+" -> factor()
                "-" -> -factor()
                "(" -> {
                    val value = expression()
                    if (index >= tokens.size || tokens[index++] != ")") throw IllegalArgumentException()
                    value
                }
                else -> token.toDouble()
            }
        }
    }
}
