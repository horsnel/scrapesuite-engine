#!/usr/bin/env python3
"""Wrapper to run colab test with ADC auth."""
import sys
sys.argv = ["colab", "--auth", "adc", "run", "colab-test.py"]
from colab_cli.cli import app
app()
